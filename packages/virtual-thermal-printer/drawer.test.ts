import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ASB_DRAWER_KICK = 0x4

async function waitFor(check: () => Promise<boolean>, retries = 20, delay = 250) {
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

function eposJob(body: string): string {
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
		`<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">${body}</epos-print>` +
		'</s:Body></s:Envelope>'
	)
}

describe('cash drawer', () => {
	let serverProcess: ChildProcess
	let baseUrl: string
	let socketPort: number

	async function postEpos(body: string): Promise<number> {
		const response = await fetch(`${baseUrl}/cgi-bin/epos/service.cgi`, {
			method: 'POST',
			headers: { 'Content-Type': 'text/xml' },
			body: eposJob(body),
		})
		expect(response.ok).toBe(true)
		const status = (await response.text()).match(/status="(\d+)"/)?.[1]
		return Number(status)
	}

	async function drawerOpen(): Promise<boolean> {
		return (await (await fetch(`${baseUrl}/drawer`)).json()).open
	}

	beforeAll(async () => {
		const httpPort = 7000 + Math.floor(Math.random() * 1000)
		socketPort = 8100 + Math.floor(Math.random() * 1000)
		baseUrl = `http://127.0.0.1:${httpPort}`
		serverProcess = spawn(
			process.execPath,
			['--import', 'tsx/esm', '--conditions=source', join(__dirname, 'main.ts'), '--http', `${httpPort}`, '--socket', `${socketPort}`],
			{ stdio: 'inherit' },
		)
		await waitFor(async () => (await fetch(`${baseUrl}/health`)).ok, 40)
	}, 30_000)

	afterAll(async () => {
		serverProcess.kill()
		await new Promise((resolve) => serverProcess.on('close', resolve))
	})

	it('starts closed, and a status request reports it closed', async () => {
		expect(await drawerOpen()).toBe(false)
		expect((await postEpos('')) & ASB_DRAWER_KICK).toBe(0)
	})

	it('opens on an ePOS <pulse> and reports it open', async () => {
		expect((await postEpos('<pulse drawer="drawer_1" time="pulse_100"/>')) & ASB_DRAWER_KICK).toBe(ASB_DRAWER_KICK)
		expect(await drawerOpen()).toBe(true)
		expect((await postEpos('')) & ASB_DRAWER_KICK).toBe(ASB_DRAWER_KICK)
	})

	it('closes from the web interface', async () => {
		const response = await fetch(`${baseUrl}/drawer/close`, { method: 'POST' })
		expect(await response.json()).toEqual({ type: 'drawer', open: false })
		expect((await postEpos('')) & ASB_DRAWER_KICK).toBe(0)
	})

	it('opens from the web interface', async () => {
		await fetch(`${baseUrl}/drawer/open`, { method: 'POST' })
		expect((await postEpos('')) & ASB_DRAWER_KICK).toBe(ASB_DRAWER_KICK)
		await fetch(`${baseUrl}/drawer/close`, { method: 'POST' })
	})

	it('opens on ESC p sent raw to the socket', async () => {
		await new Promise<void>((resolve, reject) => {
			const socket = connect(socketPort, '127.0.0.1', () => {
				socket.end(new Uint8Array([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]))
			})
			socket.on('close', () => resolve())
			socket.on('error', reject)
		})
		await waitFor(drawerOpen)
		await fetch(`${baseUrl}/drawer/close`, { method: 'POST' })
	})

	it('tells web clients the drawer state on connect and on every change', async () => {
		const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/stream`)
		const messages: unknown[] = []
		ws.on('message', (data) => messages.push(JSON.parse(String(data))))
		await new Promise((resolve) => ws.on('open', resolve))
		await waitFor(async () => messages.length >= 1)
		await postEpos('<pulse/>')
		await fetch(`${baseUrl}/drawer/close`, { method: 'POST' })
		await waitFor(async () => messages.filter((m) => (m as { type: string }).type === 'drawer').length >= 3)
		ws.close()
		expect(messages.filter((m) => (m as { type: string }).type === 'drawer')).toEqual([
			{ type: 'drawer', open: false },
			{ type: 'drawer', open: true },
			{ type: 'drawer', open: false },
		])
	})
})
