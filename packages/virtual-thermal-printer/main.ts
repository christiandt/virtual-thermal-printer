import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebSocketServer, WebSocket } from 'ws'
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createServer as createHttpsServer } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isSea, getAsset } from 'node:sea'
import { handleConnection, processEscPosStream } from './escpos.js'
import { ASB_DRAWER_KICK, ASB_PRINT_SUCCESS, eposResponse, parseEposRequest } from './epos.js'
import { CashDrawer } from './drawer.js'
import { DEFAULT_CERT_PATH, DEFAULT_KEY_PATH, loadOrCreateCertificate } from './https.js'
import { PrinterCondition } from './printer.js'
import { JobLog } from './jobs.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const appVersion = (() => {
	if (isSea()) {
		return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown'
	}
	try {
		const pkgJson = JSON.parse(
			readFileSync(join(__dirname, 'package.json'), 'utf-8'),
		)
		if (typeof pkgJson.version === 'string') {
			return pkgJson.version
		}
	} catch (event) {
		console.error(
			'Failed to read app version from package.json:',
			event instanceof Error ? event.message : event,
		)
	}
	return 'unknown'
})()
console.log(`App version: ${appVersion}`)

const { values: flags } = parseArgs({
	args: process.argv.slice(2),
	options: {
		http: { type: 'string', default: '80' },
		socket: { type: 'string', default: '9100' },
		// HTTPS is off unless a port is given.
		https: { type: 'string' },
		cert: { type: 'string', default: DEFAULT_CERT_PATH },
		key: { type: 'string', default: DEFAULT_KEY_PATH },
	},
})

function validatePort(portValue: string | number, portName: string): number {
	const port = typeof portValue === 'string' ? parseInt(portValue) : portValue
	if (isNaN(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid ${portName} port.`)
	}
	return port
}

const httpPort = validatePort(flags['http'] ?? '80', 'HTTP')
const socketPort = validatePort(flags['socket'] ?? '9100', 'Socket')
const httpsPort = flags['https'] === undefined ? null : validatePort(flags['https'], 'HTTPS')

const app = new Hono()

app.get('/health', (context) => context.text('OK'))
app.get('/version', (context) => context.text(appVersion))

const drawer = new CashDrawer()
const handleBlock = drawer.handleBlock.bind(drawer)
const printer = new PrinterCondition()
const jobs = new JobLog()

function printerStatus(): number {
	return (
		(printer.isOnline ? ASB_PRINT_SUCCESS : 0) |
		(drawer.isOpen ? ASB_DRAWER_KICK : 0) |
		printer.statusBits
	)
}

const eposEndpoint = '/cgi-bin/epos/service.cgi'
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
	app.use('/*', serveStatic({ root: join(__dirname, 'dist') }) as any)
}

const connectedClients = new Set<WebSocket>()

const server: ServerType = serve(
	{
		fetch: app.fetch,
		port: httpPort,
		hostname: '0.0.0.0',
	},
	(info) => {
		console.log(`Listening to HTTP on http://${info.address}:${info.port}.`)
	},
)

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
acceptWebSockets(server)

if (httpsPort !== null) {
	const certificate = loadOrCreateCertificate(flags['cert']!, flags['key']!)
	console.log(
		`${certificate.generated ? 'Generated a self-signed certificate' : 'Using the certificate'} at ${flags['cert']}` +
			` for ${certificate.names.join(', ')} (SHA-256 ${certificate.fingerprint}).`,
	)
	const httpsServer: ServerType = serve(
		{
			fetch: app.fetch,
			port: httpsPort,
			hostname: '0.0.0.0',
			createServer: createHttpsServer,
			serverOptions: { cert: certificate.cert, key: certificate.key },
		},
		(info) => {
			console.log(`Listening to HTTPS on https://${info.address}:${info.port}.`)
		},
	)
	acceptWebSockets(httpsServer)
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
escposServer.listen(socketPort, '0.0.0.0', () => {
	console.log(`Listening to Socket on port ${socketPort}.`)
})
