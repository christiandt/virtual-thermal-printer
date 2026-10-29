// The printer as a module: the HTTP (and HTTPS) server with the ePOS endpoint,
// web interface and control API, and the raw ESC/POS socket. main.ts starts
// it from the command line; the desktop app starts it in-process.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAdaptorServer } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server } from 'node:net'
import { createServer as createHttpsServer } from 'node:https'
import { hostname, networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { handleConnection, processEscPosStream } from './escpos.js'
import { ASB_DRAWER_KICK, ASB_PRINT_SUCCESS, eposResponse, parseEposRequest } from './epos.js'
import { CashDrawer } from './drawer.js'
import { DEFAULT_CERT_PATH, DEFAULT_KEY_PATH, loadOrCreateCertificate, type Certificate } from './https.js'
import { PrinterCondition } from './printer.js'
import { JobLog } from './jobs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Loaded at run time: test runners cannot resolve a static node:sea import.
const { isSea, getAsset } = process.getBuiltinModule('node:sea') as typeof import('node:sea')

export const EPOS_PATH = '/cgi-bin/epos/service.cgi'

export interface PrinterOptions {
	httpPort: number
	socketPort: number
	/** HTTPS is off unless a port is given. */
	httpsPort?: number | null
	certPath?: string
	keyPath?: string
	/** How many ports to try, counting up, when one is in use (default 1:
	 *  only the given port). */
	portAttempts?: number
	/** Where the web interface is served from (not used in a SEA binary). */
	staticRoot?: string
	version?: string
}

export interface RunningPrinter {
	httpPort: number
	socketPort: number
	httpsPort: number | null
	certificate: Certificate | null
	close(): Promise<void>
}

/** What a POS needs to reach the printer, as GET /info and the web
 *  interface show it. */
export interface PrinterInfo {
	version: string
	httpPort: number
	httpsPort: number | null
	socketPort: number
	eposPath: string
	/** This machine's host name and network addresses, for a POS elsewhere. */
	hosts: string[]
}

/** The host name and IPv4 addresses a POS on the network can use. */
export function networkHosts(): string[] {
	const hosts = [hostname()]
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (!address.internal && address.family === 'IPv4') hosts.push(address.address)
		}
	}
	return hosts
}

/** Listen on the port, or the next ones when it is in use; the port used. */
function listen(server: Server | ServerType, port: number, attempts: number, name: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const tryPort = (candidate: number) => {
			// Both listeners are removed whichever fires: a listening callback
			// left over from a failed port would report that port later.
			const onListening = () => {
				server.off('error', onError)
				resolve(candidate)
			}
			const onError = (error: NodeJS.ErrnoException) => {
				server.off('listening', onListening)
				if (error.code === 'EADDRINUSE' && candidate < port + attempts - 1) {
					console.log(`${name} port ${candidate} is in use, trying ${candidate + 1}.`)
					tryPort(candidate + 1)
				} else {
					reject(error)
				}
			}
			server.once('error', onError)
			server.once('listening', onListening)
			server.listen(candidate, '0.0.0.0')
		}
		tryPort(port)
	})
}

export async function startPrinter(options: PrinterOptions): Promise<RunningPrinter> {
	const attempts = Math.max(1, options.portAttempts ?? 1)
	const app = new Hono()
	const connectedClients = new Set<WebSocket>()
	let info: PrinterInfo | null = null

	app.get('/health', (context) => context.text('OK'))
	app.get('/version', (context) => context.text(options.version ?? 'unknown'))
	app.get('/info', (context) => (info ? context.json(info) : context.text('Starting', 503)))

	const drawer = new CashDrawer()
	const handleBlock = drawer.handleBlock.bind(drawer)
	const printer = new PrinterCondition()
	const jobs = new JobLog()

	function printerStatus(): number {
		return (
			(printer.isOnline ? ASB_PRINT_SUCCESS : 0) |
			(drawer.sensorHigh ? ASB_DRAWER_KICK : 0) |
			printer.statusBits
		)
	}

	const eposEndpoint = EPOS_PATH
	app.use(eposEndpoint, cors())
	app.post(eposEndpoint, async (context) => {
		const job = parseEposRequest(await context.req.text())
		if (!job) {
			return context.text('Invalid ePOS request', 400)
		}
		if (job.unsupported.length > 0) {
			console.log(`ePOS elements not supported, skipped: ${[...new Set(job.unsupported)].join(', ')}.`)
		}

		let errorCode: string | null = null
		if (!printer.isOnline) {
			// An off-line printer prints nothing and fails the job with its error.
			errorCode = printer.errorCode
			if (!job.isStatusRequest) {
				console.log(`ePOS job refused, printer off line (${errorCode}).`)
				jobs.refused('epos', job.printJobId, errorCode!)
			}
		} else if (!job.isStatusRequest) {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(job.bytes)
					controller.close()
				},
			})
			const recorder = jobs.start('epos', job.printJobId)
			await processEscPosStream(stream, connectedClients, (block) => {
				handleBlock(block)
				recorder.add(block)
			})
			recorder.finish()
		}

		// The job has run; the answer may be slow, or never come.
		const signal = context.req.raw.signal
		if (printer.noResponse && !job.isStatusRequest) {
			console.log('ePOS response withheld (printer set to never answer print jobs).')
			await waitUntilAborted(signal, NO_RESPONSE_HOLD_MS)
		} else if (printer.responseDelayMs > 0) {
			await waitUntilAborted(signal, printer.responseDelayMs)
		}
		return context.text(eposResponse(printerStatus(), job.printJobId, errorCode), 200, {
			'Content-Type': 'text/xml',
		})
	})

	/** How long a request is held when the printer never answers; clients give
	 *  up long before. */
	const NO_RESPONSE_HOLD_MS = 5 * 60_000

	/** Wait for the given time, or until the client gives up on the request. */
	function waitUntilAborted(signal: AbortSignal, ms: number): Promise<void> {
		return new Promise((resolve) => {
			if (signal.aborted) return resolve()
			const timer = setTimeout(resolve, ms)
			signal.addEventListener('abort', () => {
				clearTimeout(timer)
				resolve()
			}, { once: true })
		})
	}

	app.get('/drawer', (context) => context.json(drawer.state))
	app.post('/drawer', async (context) => {
		const change = await context.req.json().catch(() => null)
		if (typeof change !== 'object' || change === null || Object.keys(change).some((key) => key !== 'sensorHighWhenOpen') ||
			typeof change.sensorHighWhenOpen !== 'boolean') {
			return context.text('Expected {"sensorHighWhenOpen": true | false}', 400)
		}
		drawer.setSensor(change.sensorHighWhenOpen)
		return context.json(drawer.state)
	})
	app.post('/drawer/open', (context) => {
		drawer.set(true)
		return context.json(drawer.state)
	})
	app.post('/drawer/close', (context) => {
		drawer.set(false)
		return context.json(drawer.state)
	})

	app.get('/jobs', (context) => {
		const since = Number(context.req.query('since') ?? 0)
		return context.json(jobs.list(Number.isFinite(since) ? since : 0))
	})
	app.get('/jobs/:id', (context) => {
		const job = jobs.get(Number(context.req.param('id')))
		return job ? context.json(job) : context.text('No such job', 404)
	})
	app.delete('/jobs', (context) => {
		jobs.clear()
		return context.body(null, 204)
	})

	app.get('/printer', (context) => context.json(printer.state))
	app.post('/printer', async (context) => {
		const change = await context.req.json().catch(() => null)
		if (!printer.update(change)) {
			return context.text('Expected a JSON object of coverOpen, paperEnd and paperNearEnd booleans', 400)
		}
		return context.json(printer.state)
	})

	if (isSea()) {
		const mimeTypes: Record<string, string> = {
			html: 'text/html; charset=utf-8',
			js: 'application/javascript',
			css: 'text/css',
			png: 'image/png',
			mp3: 'audio/mpeg',
			json: 'application/json',
			webmanifest: 'application/manifest+json',
			map: 'application/json',
		}
		app.use('/*', (context) => {
			const assetKey = context.req.path.replace(/^\//, '') || 'index.html'
			const ext = assetKey.split('.').pop() ?? ''
			try {
				const data = getAsset(assetKey) as ArrayBuffer
				return context.body(data, 200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' })
			} catch {
				try {
					const data = getAsset('index.html') as ArrayBuffer
					return context.body(data, 200, { 'Content-Type': 'text/html; charset=utf-8' })
				} catch {
					return context.text('Not found', 404)
				}
			}
		})
	} else {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		app.use('/*', serveStatic({ root: options.staticRoot ?? join(__dirname, 'dist') }) as any)
	}

	const wss = new WebSocketServer({ noServer: true })

	function acceptWebSockets(target: ServerType): void {
		target.on('upgrade', (request, socket, head) => {
			if (request.url === '/stream') {
				wss.handleUpgrade(request, socket, head, (ws) => {
					wss.emit('connection', ws, request)
				})
			} else {
				socket.destroy()
			}
		})
	}

	wss.on('connection', (ws) => {
		console.log('WebSocket opened.')
		connectedClients.add(ws)
		ws.send(JSON.stringify(drawer.state))
		ws.send(JSON.stringify(printer.state))
		ws.on('close', () => {
			console.log('WebSocket closed.')
			connectedClients.delete(ws)
		})
		ws.on('error', (err) => {
			console.log('WebSocket error:', err.message)
			connectedClients.delete(ws)
		})
	})

	function broadcast(state: object): void {
		const message = JSON.stringify(state)
		for (const client of connectedClients) {
			client.send(message)
		}
	}
	drawer.onChange(broadcast)
	printer.onChange(broadcast)

	const server = createAdaptorServer({ fetch: app.fetch })
	acceptWebSockets(server)
	const httpPort = await listen(server, options.httpPort, attempts, 'HTTP')
	console.log(`Listening to HTTP on http://0.0.0.0:${httpPort}.`)

	let httpsServer: ServerType | null = null
	let httpsPort: number | null = null
	let certificate: Certificate | null = null
	if (options.httpsPort != null) {
		const certPath = options.certPath ?? DEFAULT_CERT_PATH
		certificate = loadOrCreateCertificate(certPath, options.keyPath ?? DEFAULT_KEY_PATH)
		console.log(
			`${certificate.generated ? 'Generated a self-signed certificate' : 'Using the certificate'} at ${certPath}` +
				` for ${certificate.names.join(', ')} (SHA-256 ${certificate.fingerprint}).`,
		)
		httpsServer = createAdaptorServer({
			fetch: app.fetch,
			createServer: createHttpsServer,
			serverOptions: { cert: certificate.cert, key: certificate.key },
		})
		acceptWebSockets(httpsServer)
		httpsPort = await listen(httpsServer, options.httpsPort, attempts, 'HTTPS')
		console.log(`Listening to HTTPS on https://0.0.0.0:${httpsPort}.`)
	}

	const escposServer = createServer((socket) => {
		const recorder = jobs.start('socket')
		handleConnection(
			socket,
			connectedClients,
			(block) => {
				handleBlock(block)
				recorder.add(block)
			},
			() => printer.whenOnline(),
		).finally(() => recorder.finish())
	})
	const socketPort = await listen(escposServer, options.socketPort, attempts, 'Socket')
	console.log(`Listening to Socket on port ${socketPort}.`)

	info = {
		version: options.version ?? 'unknown',
		httpPort,
		httpsPort,
		socketPort,
		eposPath: EPOS_PATH,
		hosts: networkHosts(),
	}

	return {
		httpPort,
		socketPort,
		httpsPort,
		certificate,
		async close() {
			for (const client of connectedClients) client.terminate()
			const closing = [server, httpsServer, escposServer]
				.filter((target) => target !== null)
				.map((target) => new Promise<void>((resolve) => target!.close(() => resolve())))
			await Promise.all(closing)
		},
	}
}
