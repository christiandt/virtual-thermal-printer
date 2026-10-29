import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import {
	ASB_COVER_OPEN,
	ASB_OFF_LINE,
	ASB_RECEIPT_END,
	ASB_RECEIPT_NEAR_END,
	PrinterCondition,
} from './printer.js'
import { startServer, waitFor, type TestServer } from './test-server.js'

const ASB_PRINT_SUCCESS = 0x2
const ASB_DRAWER_KICK = 0x4

describe('PrinterCondition', () => {
	it('is on line with no status bits by default', () => {
		const printer = new PrinterCondition()
		expect(printer.isOnline).toBe(true)
		expect(printer.statusBits).toBe(0)
		expect(printer.errorCode).toBeNull()
	})

	it('goes off line with an open cover', () => {
		const printer = new PrinterCondition()
		printer.update({ coverOpen: true })
		expect(printer.isOnline).toBe(false)
		expect(printer.statusBits).toBe(ASB_OFF_LINE | ASB_COVER_OPEN)
		expect(printer.errorCode).toBe('EPTR_COVER_OPEN')
	})

	it('goes off line without paper, with the near-end sensor tripped too', () => {
		const printer = new PrinterCondition()
		printer.update({ paperEnd: true })
		expect(printer.statusBits).toBe(ASB_OFF_LINE | ASB_RECEIPT_END | ASB_RECEIPT_NEAR_END)
		expect(printer.errorCode).toBe('EPTR_REC_EMPTY')
	})

	it('stays on line with paper near end', () => {
		const printer = new PrinterCondition()
		printer.update({ paperNearEnd: true })
		expect(printer.isOnline).toBe(true)
		expect(printer.statusBits).toBe(ASB_RECEIPT_NEAR_END)
	})

	it('rejects unknown conditions and non-boolean values', () => {
		const printer = new PrinterCondition()
		expect(printer.update({ jammed: true })).toBe(false)
		expect(printer.update({ coverOpen: 'yes' })).toBe(false)
		expect(printer.update(null)).toBe(false)
		expect(printer.update([true])).toBe(false)
		expect(printer.state.coverOpen).toBe(false)
	})

	it('waits for the printer to come back on line', async () => {
		const printer = new PrinterCondition()
		printer.update({ coverOpen: true })
		let resumed = false
		const waiting = printer.whenOnline().then(() => {
			resumed = true
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(resumed).toBe(false)
		printer.update({ coverOpen: false })
		await waiting
		expect(resumed).toBe(true)
	})
})

describe('printer conditions over HTTP', () => {
	let server: TestServer

	async function setCondition(change: object): Promise<Response> {
		return fetch(`${server.baseUrl}/printer`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(change),
		})
	}

	async function drawerOpen(): Promise<boolean> {
		return (await (await fetch(`${server.baseUrl}/drawer`)).json()).open
	}

	beforeAll(async () => {
		server = await startServer()
	}, 30_000)

	afterAll(() => server.stop())

	afterEach(async () => {
		await setCondition({ coverOpen: false, paperEnd: false, paperNearEnd: false })
		await fetch(`${server.baseUrl}/drawer/close`, { method: 'POST' })
	})

	it('reports the printer on line by default', async () => {
		expect(await (await fetch(`${server.baseUrl}/printer`)).json()).toEqual({
			type: 'printer',
			coverOpen: false,
			paperEnd: false,
			paperNearEnd: false,
		})
		expect(await server.postEpos('')).toEqual({ success: true, code: '', status: ASB_PRINT_SUCCESS })
	})

	it('fails status requests and jobs while the cover is open, and runs nothing', async () => {
		await setCondition({ coverOpen: true })
		expect(await server.postEpos('')).toEqual({
			success: false,
			code: 'EPTR_COVER_OPEN',
			status: ASB_OFF_LINE | ASB_COVER_OPEN,
		})
		const job = await server.postEpos('<text>Receipt</text><pulse/><cut/>')
		expect(job.success).toBe(false)
		expect(job.code).toBe('EPTR_COVER_OPEN')
		expect(await drawerOpen()).toBe(false)
	})

	it('fails jobs without paper', async () => {
		await setCondition({ paperEnd: true })
		const job = await server.postEpos('<text>Receipt</text>')
		expect(job).toEqual({
			success: false,
			code: 'EPTR_REC_EMPTY',
			status: ASB_OFF_LINE | ASB_RECEIPT_END | ASB_RECEIPT_NEAR_END,
		})
	})

	it('keeps printing with paper near end, and says so in the status', async () => {
		await setCondition({ paperNearEnd: true })
		expect(await server.postEpos('<text>Receipt</text>')).toEqual({
			success: true,
			code: '',
			status: ASB_PRINT_SUCCESS | ASB_RECEIPT_NEAR_END,
		})
	})

	it('reports the drawer alongside a printer condition', async () => {
		await fetch(`${server.baseUrl}/drawer/open`, { method: 'POST' })
		await setCondition({ coverOpen: true })
		expect((await server.postEpos('')).status & ASB_DRAWER_KICK).toBe(ASB_DRAWER_KICK)
	})

	it('holds raw ESC/POS until the printer is back on line', async () => {
		await setCondition({ coverOpen: true })
		const sent = server.sendRaw([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa])
		await new Promise((resolve) => setTimeout(resolve, 500))
		expect(await drawerOpen()).toBe(false)
		await setCondition({ coverOpen: false })
		await sent
		await waitFor(drawerOpen)
	})

	it('rejects a malformed change', async () => {
		expect((await setCondition({ coverOpen: 'yes' })).status).toBe(400)
		const response = await fetch(`${server.baseUrl}/printer`, { method: 'POST', body: 'not json' })
		expect(response.status).toBe(400)
	})

	it('tells web clients the condition on connect and on every change', async () => {
		const ws = new WebSocket(`${server.baseUrl.replace('http', 'ws')}/stream`)
		const messages: { type: string }[] = []
		ws.on('message', (data) => messages.push(JSON.parse(String(data))))
		await new Promise((resolve) => ws.on('open', resolve))
		await setCondition({ paperEnd: true })
		await setCondition({ paperEnd: false })
		await waitFor(async () => messages.filter((m) => m.type === 'printer').length >= 3)
		ws.close()
		expect(messages.filter((m) => m.type === 'printer').map((m) => (m as unknown as { paperEnd: boolean }).paperEnd))
			.toEqual([false, true, false])
	})
})
