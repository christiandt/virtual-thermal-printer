// Printer error conditions, set from the web interface.
//
// An open cover or an empty paper roll takes the printer off line: it prints
// nothing, ePOS jobs fail with the matching error code, and raw ESC/POS jobs
// wait in the buffer until it is back on line, as on a TM printer. Paper near
// end only raises a status bit; the printer keeps printing.
//
// The ePOS response can also be slow, or for print jobs never come, to test
// how a POS times out: the printer prints at once either way, so a job can be
// on paper while the POS is still waiting for (or has given up on) the
// answer. Status requests still answer when print jobs do not, so the POS
// gets as far as printing.

// ASB (automatic status back) bits of the ePOS response's `status` attribute.
export const ASB_OFF_LINE = 0x00000008
export const ASB_COVER_OPEN = 0x00000020
export const ASB_RECEIPT_NEAR_END = 0x00020000
export const ASB_RECEIPT_END = 0x00080000

/** The longest response delay that can be set. */
export const MAX_RESPONSE_DELAY_MS = 60_000

export interface PrinterConditionState {
	type: 'printer'
	coverOpen: boolean
	paperEnd: boolean
	paperNearEnd: boolean
	/** How long every ePOS response waits after the job has run. */
	responseDelayMs: number
	/** The printer runs ePOS print jobs but never answers them; status
	 *  requests are still answered. */
	noResponse: boolean
}

export type PrinterConditionChange = Partial<Omit<PrinterConditionState, 'type'>>

const BOOLEAN_FIELDS = ['coverOpen', 'paperEnd', 'paperNearEnd', 'noResponse']

function isValidField(key: string, value: unknown): boolean {
	if (key === 'responseDelayMs') {
		return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_RESPONSE_DELAY_MS
	}
	return BOOLEAN_FIELDS.includes(key) && typeof value === 'boolean'
}

type Listener = (state: PrinterConditionState) => void

export class PrinterCondition {
	#coverOpen = false
	#paperEnd = false
	#paperNearEnd = false
	#responseDelayMs = 0
	#noResponse = false
	#listeners = new Set<Listener>()
	#waitingForOnline: (() => void)[] = []

	get state(): PrinterConditionState {
		return {
			type: 'printer',
			coverOpen: this.#coverOpen,
			paperEnd: this.#paperEnd,
			paperNearEnd: this.#paperNearEnd,
			responseDelayMs: this.#responseDelayMs,
			noResponse: this.#noResponse,
		}
	}

	get responseDelayMs(): number {
		return this.#responseDelayMs
	}

	get noResponse(): boolean {
		return this.#noResponse
	}

	get isOnline(): boolean {
		return !this.#coverOpen && !this.#paperEnd
	}

	/** The condition's ASB bits. An empty roll also trips the near-end sensor. */
	get statusBits(): number {
		return (
			(this.isOnline ? 0 : ASB_OFF_LINE) |
			(this.#coverOpen ? ASB_COVER_OPEN : 0) |
			(this.#paperEnd ? ASB_RECEIPT_END : 0) |
			(this.#paperEnd || this.#paperNearEnd ? ASB_RECEIPT_NEAR_END : 0)
		)
	}

	/** The ePOS error code a job fails with, or null when the printer is on line. */
	get errorCode(): string | null {
		if (this.#coverOpen) return 'EPTR_COVER_OPEN'
		if (this.#paperEnd) return 'EPTR_REC_EMPTY'
		return null
	}

	/** Apply a change; false when it holds an unknown field or a bad value
	 *  (conditions are booleans, the delay whole milliseconds up to a minute). */
	update(change: unknown): boolean {
		if (typeof change !== 'object' || change === null || Array.isArray(change)) {
			return false
		}
		const entries = Object.entries(change)
		if (entries.some(([key, value]) => !isValidField(key, value))) {
			return false
		}
		const before = JSON.stringify(this.state)
		const next = change as PrinterConditionChange
		this.#coverOpen = next.coverOpen ?? this.#coverOpen
		this.#paperEnd = next.paperEnd ?? this.#paperEnd
		this.#paperNearEnd = next.paperNearEnd ?? this.#paperNearEnd
		this.#responseDelayMs = next.responseDelayMs ?? this.#responseDelayMs
		this.#noResponse = next.noResponse ?? this.#noResponse
		if (JSON.stringify(this.state) !== before) {
			const response = this.#noResponse
				? ', never answers print jobs'
				: this.#responseDelayMs > 0 ? `, answers after ${this.#responseDelayMs} ms` : ''
			console.log(`Printer ${this.isOnline ? 'on line' : `off line (${this.errorCode})`}${this.#paperNearEnd ? ', paper near end' : ''}${response}.`)
			for (const listener of this.#listeners) {
				listener(this.state)
			}
		}
		if (this.isOnline) {
			for (const resolve of this.#waitingForOnline.splice(0)) resolve()
		}
		return true
	}

	onChange(listener: Listener): void {
		this.#listeners.add(listener)
	}

	/** Resolves once the printer is on line (at once when it already is). */
	whenOnline(): Promise<void> {
		if (this.isOnline) return Promise.resolve()
		return new Promise((resolve) => this.#waitingForOnline.push(resolve))
	}
}
