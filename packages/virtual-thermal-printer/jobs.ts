// A record of the print jobs the printer received, for tests to read back
// what was printed: GET /jobs lists them with their text, GET /jobs/:id adds
// the decoded blocks. An ePOS request is one job, a socket connection is one
// job. Status requests are not jobs; a job refused while the printer was off
// line is kept, with printed false and the error code.
//
// The text follows the renderer's rows: every command that ends a row there
// ends a line here. Long lines are deliberately not wrapped at the paper
// width (that depends on font, size and margins), so each line a POS sent
// stays whole for assertions.
import type { ParsedEscPosBlock } from 'escpos-decoder/types'

/** Commands that end the open row in the renderer without a feed of their
 *  own here. Line feeds, images, cuts and page prints are handled apart. */
const ROW_ENDING_COMMANDS = new Set([
	'Print and Feed Paper', // ESC J
	'Print and Reverse Feed Lines', // ESC e
])

/** Page layout commands end the row too, but only in page mode: the
 *  renderer ignores them in standard mode. */
const PAGE_ROW_ENDING_COMMANDS = new Set([
	'Set Page Area', // ESC W
	'Select Print Direction', // ESC T
	'Set Absolute Vertical Position', // GS $
	'Set Relative Vertical Position', // GS \
])

/** How many jobs are kept; older ones are dropped first. */
export const JOB_LOG_SIZE = 100

export interface JobSummary {
	id: number
	source: 'epos' | 'socket'
	/** When the job arrived, as an ISO timestamp. */
	receivedAt: string
	/** The ePOS request's printjobid, when it had one. */
	printJobId: string | null
	printed: boolean
	/** The ePOS error code a refused job failed with. */
	errorCode: string | null
	/** The printed text, with feeds as line breaks and images as [image W×H]. */
	text: string
	/** Paper cuts in the job. */
	cuts: number
	/** Drawer kick pulses in the job. */
	drawerPulses: number
}

export interface Job extends JobSummary {
	blocks: ParsedEscPosBlock[]
}

export class JobRecorder {
	readonly #job: Job
	readonly #keep: (job: Job) => void
	readonly #pages: PageBuffer

	constructor(job: Job, keep: (job: Job) => void, pages: PageBuffer) {
		this.#job = job
		this.#keep = keep
		this.#pages = pages
	}

	get #page(): string | null {
		return this.#pages.text
	}

	set #page(text: string | null) {
		this.#pages.text = text
	}

	add(block: ParsedEscPosBlock): void {
		const job = this.#job
		job.blocks.push(block)
		if (block.type === 'text') {
			this.#write(block.content.replace(/\r/g, ''))
		} else if (block.type === 'image') {
			// An image starts on a row of its own.
			this.#endLine()
			this.#write(`[image ${block.width}×${block.height}]\n`)
		} else if (block.name === 'Print and Feed Lines') {
			// ESC d 0 prints the row without feeding: it still ends it.
			const lines = Number(block.details?.lines ?? 0)
			if (lines === 0) this.#endLine()
			else this.#write('\n'.repeat(lines))
		} else if (ROW_ENDING_COMMANDS.has(block.name)) {
			this.#endLine()
		} else if (PAGE_ROW_ENDING_COMMANDS.has(block.name)) {
			if (this.#page !== null) this.#endLine()
		} else if (block.name === 'Select Page Mode') {
			// The standard-mode row ends before the page begins.
			this.#endLine()
			this.#page ??= ''
		} else if (block.name === 'Print Page') {
			// ESC FF prints the page and keeps it for further printing.
			this.#printPage()
		} else if (block.name === 'Form Feed') {
			this.#printPage()
			this.#page = null
		} else if (block.name === 'Cancel Page Data') {
			if (this.#page !== null) this.#page = ''
		} else if (block.name === 'Select Standard Mode' || block.name === 'Initialize Printer') {
			// Leaving page mode drops the unprinted page with its open row; in
			// standard mode ESC S ends the row.
			if (this.#page === null && block.name === 'Select Standard Mode') this.#endLine()
			this.#page = null
		} else if (block.name === 'Cut Paper') {
			// A cut ends the row in standard mode, as in the renderer.
			if (this.#page === null) this.#endLine()
			job.cuts++
		} else if (
			block.name === 'Generate Pulse' ||
			(block.name === 'Real-Time Command' && block.details?.fn === 1)
		) {
			job.drawerPulses++
		}
	}

	#write(text: string): void {
		if (this.#page !== null) this.#page += text
		else this.#job.text += text
	}

	#endLine(): void {
		if (this.#page !== null) {
			if (this.#page && !this.#page.endsWith('\n')) this.#page += '\n'
		} else if (this.#job.text && !this.#job.text.endsWith('\n')) {
			this.#job.text += '\n'
		}
	}

	/** Print the page, ending its open row first: what follows starts on a
	 *  new row of the kept page, as in the renderer. */
	#printPage(): void {
		if (this.#page === null) return
		this.#endLine()
		this.#job.text += this.#page
	}

	/** Record the job. A socket connection that decoded nothing (a probe) is
	 *  not one; an ePOS request is, even when it printed nothing. */
	finish(): void {
		if (this.#job.source === 'epos' || this.#job.blocks.length > 0) {
			this.#keep(this.#job)
		}
	}
}

/** Page-mode text held until the page is printed. It belongs to the
 *  printer, not to one job: like the renderer, a page begun in one job can be
 *  printed by the next, and a cancelled or unprinted page never prints. */
export interface PageBuffer {
	text: string | null
}

export class JobLog {
	#jobs: Job[] = []
	#nextId = 1
	#pages: PageBuffer = { text: null }

	start(source: Job['source'], printJobId: string | null = null): JobRecorder {
		return new JobRecorder(this.#newJob(source, printJobId), (job) => this.#keep(job), this.#pages)
	}

	/** Keep a job the printer refused: it printed nothing. */
	refused(source: Job['source'], printJobId: string | null, errorCode: string): void {
		this.#keep({ ...this.#newJob(source, printJobId), printed: false, errorCode })
	}

	/** Jobs after the given id, oldest first, without their blocks. */
	list(sinceId = 0): JobSummary[] {
		return this.#jobs
			.filter((job) => job.id > sinceId)
			.map(({ blocks: _blocks, ...summary }) => summary)
	}

	get(id: number): Job | null {
		return this.#jobs.find((job) => job.id === id) ?? null
	}

	clear(): void {
		this.#jobs = []
	}

	#newJob(source: Job['source'], printJobId: string | null): Job {
		return {
			id: 0,
			source,
			receivedAt: new Date().toISOString(),
			printJobId,
			printed: true,
			errorCode: null,
			text: '',
			cuts: 0,
			drawerPulses: 0,
			blocks: [],
		}
	}

	// Ids follow the order jobs are recorded in, so ?since= never skips a
	// socket job that waited for the printer to come back on line.
	#keep(job: Job): void {
		job.id = this.#nextId++
		this.#jobs.push(job)
		if (this.#jobs.length > JOB_LOG_SIZE) this.#jobs.shift()
	}
}
