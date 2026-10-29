import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Alignment, type ParsedEscPosBlock } from 'escpos-decoder/types'
import { JOB_LOG_SIZE, JobLog, type Job } from './jobs.js'
import { startServer, waitFor, type TestServer } from './test-server.js'

function text(content: string): ParsedEscPosBlock {
	return {
		type: 'text',
		content,
		alignment: Alignment.Left,
		emphasized: false,
		underline: 0,
		charWidth: 1,
		charHeight: 1,
		reversePrinting: false,
		font: 0,
		rightSpacing: 0,
		leftMargin: 0,
		printAreaWidth: 0,
		tabStops: [],
		lineSpacing: null,
		doubleStrike: false,
		upsideDown: false,
		rotated: false,
	}
}

describe('JobLog', () => {
	it('records text, feeds, images, cuts and drawer pulses', () => {
		const log = new JobLog()
		const recorder = log.start('socket')
		recorder.add(text('Hello\r\n'))
		recorder.add({ type: 'command', name: 'Print and Feed Lines', details: { lines: 2 } })
		recorder.add({ type: 'image', width: 120, height: 120, base64: '', alignment: Alignment.Center })
		recorder.add({ type: 'command', name: 'Cut Paper' })
		recorder.add({ type: 'command', name: 'Generate Pulse' })
		recorder.add({ type: 'command', name: 'Real-Time Command', details: { fn: 1 } })
		recorder.finish()
		const [job] = log.list()
		expect(job).toMatchObject({
			id: 1,
			source: 'socket',
			printed: true,
			errorCode: null,
			text: 'Hello\n\n\n[image 120×120]\n',
			cuts: 1,
			drawerPulses: 2,
		})
		expect(job).not.toHaveProperty('blocks')
		expect(log.get(1)?.blocks).toHaveLength(6)
	})

	it('ends the line on a dot feed (ESC J)', () => {
		const log = new JobLog()
		const recorder = log.start('epos')
		recorder.add(text('A'))
		recorder.add({ type: 'command', name: 'Print and Feed Paper', details: { feed: 48 } })
		recorder.add(text('B'))
		recorder.finish()
		expect(log.list()[0].text).toBe('A\nB')
	})

	it('ends the line on a cut', () => {
		const log = new JobLog()
		const recorder = log.start('epos')
		recorder.add(text('A'))
		recorder.add({ type: 'command', name: 'Cut Paper' })
		recorder.add(text('B'))
		recorder.finish()
		expect(log.list()[0].text).toBe('A\nB')
	})

	it('starts an image on a row of its own, and ends the row on a zero-line feed', () => {
		const log = new JobLog()
		const recorder = log.start('epos')
		recorder.add(text('A'))
		recorder.add({ type: 'image', width: 8, height: 8, base64: '', alignment: Alignment.Left })
		recorder.add(text('B'))
		recorder.add({ type: 'command', name: 'Print and Feed Lines', details: { lines: 0 } })
		recorder.add(text('C'))
		recorder.finish()
		expect(log.list()[0].text).toBe('A\n[image 8×8]\nB\nC')
	})

	it.each([
		'Print and Reverse Feed Lines',
		'Select Page Mode',
		'Select Standard Mode',
	])('ends the line on %s', (name) => {
		const log = new JobLog()
		const recorder = log.start('epos')
		recorder.add(text('A'))
		recorder.add({ type: 'command', name })
		if (name === 'Select Page Mode') recorder.add({ type: 'command', name: 'Select Standard Mode' })
		recorder.add(text('B'))
		recorder.finish()
		expect(log.list()[0].text).toBe('A\nB')
	})

	it('ends the row within a page on page layout commands', () => {
		const log = new JobLog()
		const recorder = log.start('epos')
		recorder.add({ type: 'command', name: 'Select Page Mode' })
		for (const name of ['Set Page Area', 'Select Print Direction', 'Set Absolute Vertical Position', 'Set Relative Vertical Position']) {
			recorder.add(text(name.split(' ')[1]))
			recorder.add({ type: 'command', name })
		}
		recorder.add({ type: 'command', name: 'Form Feed' })
		recorder.finish()
		expect(log.list()[0].text).toBe('Page\nPrint\nAbsolute\nRelative\n')
	})

	it('prints a page begun in an earlier job', () => {
		const log = new JobLog()
		const first = log.start('epos')
		first.add({ type: 'command', name: 'Select Page Mode' })
		first.add(text('held'))
		first.finish()
		const second = log.start('epos')
		second.add({ type: 'command', name: 'Form Feed' })
		second.finish()
		expect(log.list().map((job) => job.text)).toEqual(['', 'held\n'])
	})

	it('keeps page-mode text only when the page is printed', () => {
		const log = new JobLog()
		const recorder = log.start('socket')
		const command = (name: string) => recorder.add({ type: 'command', name })
		command('Select Page Mode')
		recorder.add(text('cancelled'))
		command('Cancel Page Data')
		recorder.add(text('page'))
		command('Print Page') // ESC FF prints and keeps the page
		recorder.add(text(' more'))
		command('Form Feed') // FF prints it again and leaves page mode
		command('Select Page Mode')
		recorder.add(text('discarded'))
		command('Select Standard Mode')
		command('Select Page Mode')
		recorder.add(text('reset'))
		command('Initialize Printer')
		command('Select Page Mode')
		recorder.add(text('never printed'))
		command('Cut Paper')
		recorder.finish()
		expect(log.list()[0]).toMatchObject({ text: 'page\npage\n more\n', cuts: 1 })
	})

	it('does not record a job that decoded nothing', () => {
		const log = new JobLog()
		log.start('socket').finish()
		expect(log.list()).toEqual([])
	})

	it('records a refused job as not printed', () => {
		const log = new JobLog()
		log.refused('epos', 'job-1', 'EPTR_COVER_OPEN')
		expect(log.list()[0]).toMatchObject({ printed: false, errorCode: 'EPTR_COVER_OPEN', printJobId: 'job-1', text: '' })
	})

	it('numbers jobs in the order they are recorded', () => {
		const log = new JobLog()
		const early = log.start('socket')
		const late = log.start('epos')
		late.add(text('late'))
		late.finish()
		early.add(text('early'))
		early.finish()
		expect(log.list().map((job) => [job.id, job.text])).toEqual([[1, 'late'], [2, 'early']])
		expect(log.list(1).map((job) => job.text)).toEqual(['early'])
	})

	it(`keeps the last ${JOB_LOG_SIZE} jobs`, () => {
		const log = new JobLog()
		for (let i = 0; i < JOB_LOG_SIZE + 5; i++) log.refused('epos', null, 'EPTR_REC_EMPTY')
		const ids = log.list().map((job) => job.id)
		expect(ids).toHaveLength(JOB_LOG_SIZE)
		expect(ids[0]).toBe(6)
		expect(log.get(1)).toBeNull()
	})

	it('clears', () => {
		const log = new JobLog()
		log.refused('epos', null, 'EPTR_REC_EMPTY')
		log.clear()
		expect(log.list()).toEqual([])
	})
})

describe('print jobs over HTTP', () => {
	let server: TestServer

	async function listJobs(query = ''): Promise<Job[]> {
		return (await fetch(`${server.baseUrl}/jobs${query}`)).json()
	}

	beforeAll(async () => {
		server = await startServer()
	}, 30_000)

	afterAll(() => server.stop())

	beforeEach(async () => {
		await fetch(`${server.baseUrl}/jobs`, { method: 'DELETE' })
		await fetch(`${server.baseUrl}/printer`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ coverOpen: false, paperEnd: false }),
		})
	})

	it('records an ePOS job with its text, cut and pulse, but not a status request', async () => {
		await server.postEpos('')
		await server.postEpos('<text>KVITTERING&#10;</text><text>Blåbær 49,00&#10;</text><feed line="2"/><cut/><pulse/>')
		const jobs = await listJobs()
		expect(jobs).toHaveLength(1)
		expect(jobs[0]).toMatchObject({
			source: 'epos',
			printed: true,
			text: 'KVITTERING\nBlåbær 49,00\n\n\n',
			cuts: 1,
			drawerPulses: 1,
		})
	})

	it('returns a job with its decoded blocks, and 404 for an unknown one', async () => {
		await server.postEpos('<text em="true">Total</text>')
		const [summary] = await listJobs()
		const job: Job = await (await fetch(`${server.baseUrl}/jobs/${summary.id}`)).json()
		expect(job.blocks).toContainEqual(expect.objectContaining({ type: 'text', content: 'Total', emphasized: true }))
		expect((await fetch(`${server.baseUrl}/jobs/99999`)).status).toBe(404)
	})

	it('records a job refused while the printer is off line', async () => {
		await fetch(`${server.baseUrl}/printer`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ paperEnd: true }),
		})
		await server.postEpos('<text>Receipt</text>')
		expect(await listJobs()).toMatchObject([{ printed: false, errorCode: 'EPTR_REC_EMPTY', text: '' }])
	})

	it('records a raw socket job', async () => {
		await server.sendRaw([0x1b, 0x40, ...Buffer.from('Raw job\n'), 0x1d, 0x56, 0x00])
		await waitFor(async () => (await listJobs()).length === 1)
		expect((await listJobs())[0]).toMatchObject({ source: 'socket', text: 'Raw job\n', cuts: 1 })
	})

	it('lists only jobs after ?since=', async () => {
		await server.postEpos('<text>one</text>')
		const [first] = await listJobs()
		await server.postEpos('<text>two</text>')
		expect((await listJobs(`?since=${first.id}`)).map((job) => job.text)).toEqual(['two'])
	})
})
