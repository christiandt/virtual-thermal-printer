import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { CashDrawer } from './drawer.js'
import { startServer, waitFor, type TestServer } from './test-server.js'

const ASB_DRAWER_KICK = 0x4

describe('CashDrawer sensor', () => {
	it('reads HIGH while open by default, and while closed when reversed', () => {
		const drawer = new CashDrawer()
		expect(drawer.sensorHigh).toBe(false)
		drawer.set(true)
		expect(drawer.sensorHigh).toBe(true)
		drawer.setSensor(false)
		expect(drawer.sensorHigh).toBe(false)
		drawer.set(false)
		expect(drawer.sensorHigh).toBe(true)
	})

	it('tells listeners when the sensor polarity changes', () => {
		const drawer = new CashDrawer()
		const states: boolean[] = []
		drawer.onChange((state) => states.push(state.sensorHighWhenOpen))
		drawer.setSensor(false)
		drawer.setSensor(false)
		drawer.setSensor(true)
		expect(states).toEqual([false, true])
	})
})

describe('cash drawer', () => {
	let server: TestServer
	let baseUrl: string

	async function postEpos(body: string): Promise<number> {
		return (await server.postEpos(body)).status
	}

	async function drawerOpen(): Promise<boolean> {
		return (await (await fetch(`${baseUrl}/drawer`)).json()).open
	}

	beforeAll(async () => {
		server = await startServer()
		baseUrl = server.baseUrl
	}, 30_000)

	afterAll(() => server.stop())

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
		expect(await response.json()).toEqual({ type: 'drawer', open: false, sensorHighWhenOpen: true })
		expect((await postEpos('')) & ASB_DRAWER_KICK).toBe(0)
	})

	it('opens from the web interface', async () => {
		await fetch(`${baseUrl}/drawer/open`, { method: 'POST' })
		expect((await postEpos('')) & ASB_DRAWER_KICK).toBe(ASB_DRAWER_KICK)
		await fetch(`${baseUrl}/drawer/close`, { method: 'POST' })
	})

	it('opens on ESC p sent raw to the socket', async () => {
		await server.sendRaw([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa])
		await waitFor(drawerOpen)
		await fetch(`${baseUrl}/drawer/close`, { method: 'POST' })
	})

	it('reports a reversed sensor: HIGH while closed', async () => {
		const setSensor = (sensorHighWhenOpen: unknown) => fetch(`${baseUrl}/drawer`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sensorHighWhenOpen }),
		})
		expect(await (await setSensor(false)).json()).toEqual({ type: 'drawer', open: false, sensorHighWhenOpen: false })
		expect((await postEpos('')) & ASB_DRAWER_KICK).toBe(ASB_DRAWER_KICK)
		await fetch(`${baseUrl}/drawer/open`, { method: 'POST' })
		expect((await postEpos('')) & ASB_DRAWER_KICK).toBe(0)
		await fetch(`${baseUrl}/drawer/close`, { method: 'POST' })
		expect((await setSensor('no')).status).toBe(400)
		await setSensor(true)
		expect((await postEpos('')) & ASB_DRAWER_KICK).toBe(0)
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
			{ type: 'drawer', open: false, sensorHighWhenOpen: true },
			{ type: 'drawer', open: true, sensorHighWhenOpen: true },
			{ type: 'drawer', open: false, sensorHighWhenOpen: true },
		])
	})
})
