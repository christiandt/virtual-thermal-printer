import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EPOS_PATH, startPrinter, type PrinterInfo, type RunningPrinter } from './server.js'

function randomPort(): number {
	return 20_000 + Math.floor(Math.random() * 20_000)
}

function occupy(port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(port, '0.0.0.0', () => resolve(server))
	})
}

describe('startPrinter', () => {
	const cleanup: (() => Promise<void> | void)[] = []

	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	async function start(options: Parameters<typeof startPrinter>[0]): Promise<RunningPrinter> {
		const printer = await startPrinter(options)
		cleanup.push(() => printer.close())
		return printer
	}

	it('serves /info with the ports a POS should use', async () => {
		const httpPort = randomPort()
		const printer = await start({ httpPort, socketPort: httpPort + 1, version: '9.9.9' })
		const info: PrinterInfo = await (await fetch(`http://127.0.0.1:${printer.httpPort}/info`)).json()
		expect(info).toMatchObject({
			version: '9.9.9',
			httpPort,
			httpsPort: null,
			socketPort: httpPort + 1,
			eposPath: EPOS_PATH,
		})
		expect(info.hosts.length).toBeGreaterThan(0)
	})

	it('moves on to the next free ports when asked to', async () => {
		const httpPort = randomPort()
		const blockers = await Promise.all([occupy(httpPort), occupy(httpPort + 10)])
		cleanup.push(() => Promise.all(blockers.map((b) => new Promise<void>((r) => b.close(() => r())))).then(() => {}))
		const printer = await start({ httpPort, socketPort: httpPort + 10, portAttempts: 5 })
		expect(printer.httpPort).toBe(httpPort + 1)
		expect(printer.socketPort).toBe(httpPort + 11)
		expect((await fetch(`http://127.0.0.1:${printer.httpPort}/health`)).ok).toBe(true)
	})

	it('fails when the port is in use and no others may be tried', async () => {
		const httpPort = randomPort()
		const blocker = await occupy(httpPort)
		cleanup.push(() => new Promise<void>((r) => blocker.close(() => r())))
		await expect(startPrinter({ httpPort, socketPort: httpPort + 1 })).rejects.toMatchObject({ code: 'EADDRINUSE' })
	})

	it('reports the HTTPS port in /info', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'vtp-server-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
		const httpPort = randomPort()
		const printer = await start({
			httpPort,
			socketPort: httpPort + 1,
			httpsPort: httpPort + 2,
			certPath: join(dir, 'cert.pem'),
			keyPath: join(dir, 'key.pem'),
		})
		const info: PrinterInfo = await (await fetch(`http://127.0.0.1:${printer.httpPort}/info`)).json()
		expect(info.httpsPort).toBe(httpPort + 2)
		expect(printer.certificate?.names).toContain('localhost')
	})
})
