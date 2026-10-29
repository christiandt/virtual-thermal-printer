// A record of the print jobs the printer received, for tests to read back
// what was printed: GET /jobs lists them with their text, GET /jobs/:id adds
// the decoded blocks. An ePOS request is one job, a socket connection is one
// job. Status requests are not jobs; a job refused while the printer was off
// line is kept, with printed false and the error code.
import type { ParsedEscPosBlock } from 'escpos-decoder/types'

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

	constructor(job: Job, keep: (job: Job) => void) {
		this.#job = job
		this.#keep = keep
	}

	// Page-mode text, held until the page is printed: like the renderer, a
	// page that is cancelled or left unprinted never reaches the paper.
	#page: string | null = null

	add(block: ParsedEscPosBlock): void {
		const job = this.#job
		job.blocks.push(block)
		if (block.type === 'text') {
			this.#write(block.content.replace(/\r/g, ''))
		} else if (block.type === 'image') {
			this.#write(`[image ${block.width}×${block.height}]\n`)
		} else if (block.name === 'Print and Feed Lines') {
			this.#write('\n'.repeat(Number(block.details?.lines ?? 0)))
		} else if (block.name === 'Print and Feed Paper') {
			// ESC J n prints the row and feeds n dots: the row ends here.
			this.#endLine()
		} else if (block.name === 'Select Page Mode') {
			this.#page ??= ''
		} else if (block.name === 'Print Page') {
			// ESC FF prints the page and keeps it for further printing.
			if (this.#page !== null) this.#printPage(this.#page)
		} else if (block.name === 'Form Feed') {
			if (this.#page !== null) this.#printPage(this.#page)
			this.#page = null
		} else if (block.name === 'Cancel Page Data') {
			if (this.#page !== null) this.#page = ''
		} else if (block.name === 'Select Standard Mode' || block.name === 'Initialize Printer') {
			this.#page = null
		} else if (block.name === 'Cut Paper') {
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

	#printPage(page: string): void {
		this.#job.text += page && !page.endsWith('\n') ? `${page}\n` : page
	}

	/** Record the job; a socket connection that decoded nothing is not one. */
	finish(): void {
		if (this.#job.blocks.length > 0) {
			this.#keep(this.#job)
		}
	}
}

export class JobLog {
	#jobs: Job[] = []
	#nextId = 1

	start(source: Job['source'], printJobId: string | null = null): JobRecorder {
		return new JobRecorder(this.#newJob(source, printJobId), (job) => this.#keep(job))
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
