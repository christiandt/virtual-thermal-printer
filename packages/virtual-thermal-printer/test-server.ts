// Test helper: the server in a child process on random ports, plus ePOS and
// raw-socket clients for it.
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function waitFor(check: () => Promise<boolean>, retries = 20, delay = 250) {
	for (let i = 0; i < retries; i++) {
		try {
			if (await check()) return
		} catch {
			// not ready yet
		}
		await new Promise((resolve) => setTimeout(resolve, delay))
	}
	throw new Error('Condition not met in time.')
}

export function eposJob(body: string): string {
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
		`<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">${body}</epos-print>` +
		'</s:Body></s:Envelope>'
	)
}

export interface EposResult {
	success: boolean
	code: string
	status: number
}

export interface TestServer {
	baseUrl: string
	socketPort: number
	postEpos(body: string): Promise<EposResult>
	/** Send raw bytes to the ESC/POS socket and close it. */
	sendRaw(bytes: number[]): Promise<void>
	stop(): Promise<void>
}

export async function startServer(): Promise<TestServer> {
	const httpPort = 7000 + Math.floor(Math.random() * 1000)
	const socketPort = 8100 + Math.floor(Math.random() * 1000)
	const baseUrl = `http://127.0.0.1:${httpPort}`
	const serverProcess = spawn(
		process.execPath,
		['--import', 'tsx/esm', '--conditions=source', join(__dirname, 'main.ts'), '--http', `${httpPort}`, '--socket', `${socketPort}`],
		{ stdio: 'inherit' },
	)
	await waitFor(async () => (await fetch(`${baseUrl}/health`)).ok, 40)

	return {
		baseUrl,
		socketPort,
		async postEpos(body) {
			const response = await fetch(`${baseUrl}/cgi-bin/epos/service.cgi`, {
				method: 'POST',
				headers: { 'Content-Type': 'text/xml' },
				body: eposJob(body),
			})
			if (!response.ok) throw new Error(`ePOS request failed: ${response.status}`)
			const text = await response.text()
			return {
				success: /success="true"/.test(text),
				code: text.match(/code="([^"]*)"/)?.[1] ?? '',
				status: Number(text.match(/ status="(\d+)"/)?.[1]),
			}
		},
		sendRaw(bytes) {
			return new Promise<void>((resolve, reject) => {
				const socket = connect(socketPort, '127.0.0.1', () => {
					socket.end(new Uint8Array(bytes))
				})
				socket.on('close', () => resolve())
				socket.on('error', reject)
			})
		},
		async stop() {
			serverProcess.kill()
			await new Promise((resolve) => serverProcess.on('close', resolve))
		},
	}
}
