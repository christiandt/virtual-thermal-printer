// Printer error conditions, set from the web interface.
//
// An open cover or an empty paper roll takes the printer off line: it prints
// nothing, ePOS jobs fail with the matching error code, and raw ESC/POS jobs
// wait in the buffer until it is back on line, as on a TM printer. Paper near
// end only raises a status bit; the printer keeps printing.

// ASB (automatic status back) bits of the ePOS response's `status` attribute.
export const ASB_OFF_LINE = 0x00000008
export const ASB_COVER_OPEN = 0x00000020
export const ASB_RECEIPT_NEAR_END = 0x00020000
export const ASB_RECEIPT_END = 0x00080000

export interface PrinterConditionState {
	type: 'printer'
	coverOpen: boolean
	paperEnd: boolean
	paperNearEnd: boolean
}

export type PrinterConditionChange = Partial<Omit<PrinterConditionState, 'type'>>

const CONDITIONS = ['coverOpen', 'paperEnd', 'paperNearEnd'] as const

type Listener = (state: PrinterConditionState) => void

export class PrinterCondition {
	#coverOpen = false
	#paperEnd = false
	#paperNearEnd = false
	#listeners = new Set<Listener>()
	#waitingForOnline: (() => void)[] = []

	get state(): PrinterConditionState {
		return {
			type: 'printer',
			coverOpen: this.#coverOpen,
			paperEnd: this.#paperEnd,
			paperNearEnd: this.#paperNearEnd,
		}
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

	/** Apply a change; false when it holds anything but known boolean conditions. */
	update(change: unknown): boolean {
		if (typeof change !== 'object' || change === null || Array.isArray(change)) {
			return false
		}
		const entries = Object.entries(change)
		if (entries.some(([key, value]) => !(CONDITIONS as readonly string[]).includes(key) || typeof value !== 'boolean')) {
			return false
		}
		const before = JSON.stringify(this.state)
		const next = change as PrinterConditionChange
		this.#coverOpen = next.coverOpen ?? this.#coverOpen
		this.#paperEnd = next.paperEnd ?? this.#paperEnd
		this.#paperNearEnd = next.paperNearEnd ?? this.#paperNearEnd
		if (JSON.stringify(this.state) !== before) {
			console.log(`Printer ${this.isOnline ? 'on line' : `off line (${this.errorCode})`}${this.#paperNearEnd ? ', paper near end' : ''}.`)
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
