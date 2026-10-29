// Cash drawer on the printer's drawer kick-out connector.
//
// A pulse (ESC p, DLE DC4 1, or <pulse> over ePOS) opens the drawer; it stays
// open until someone closes it, here from the web interface. The printer
// reports the drawer's open/closed sensor (connector pin 3) in its status.
// Most drawers read HIGH while open; some read HIGH while closed, and a POS
// has to be set up for that. Either can be simulated.
import type { ParsedEscPosBlock } from 'escpos-decoder/types'

export interface DrawerState {
	type: 'drawer'
	open: boolean
	/** Whether the sensor (pin 3) reads HIGH while the drawer is open. */
	sensorHighWhenOpen: boolean
}

type Listener = (state: DrawerState) => void

export class CashDrawer {
	#open = false
	#sensorHighWhenOpen = true
	#listeners = new Set<Listener>()

	get isOpen(): boolean {
		return this.#open
	}

	get state(): DrawerState {
		return { type: 'drawer', open: this.#open, sensorHighWhenOpen: this.#sensorHighWhenOpen }
	}

	/** The sensor reading the printer reports (ASB_DRAWER_KICK). */
	get sensorHigh(): boolean {
		return this.#open === this.#sensorHighWhenOpen
	}

	set(open: boolean): void {
		if (open === this.#open) {
			return
		}
		this.#open = open
		console.log(`Cash drawer ${open ? 'opened' : 'closed'}.`)
		this.#notify()
	}

	setSensor(highWhenOpen: boolean): void {
		if (highWhenOpen === this.#sensorHighWhenOpen) {
			return
		}
		this.#sensorHighWhenOpen = highWhenOpen
		console.log(`Cash drawer sensor reads HIGH when ${highWhenOpen ? 'open' : 'closed'}.`)
		this.#notify()
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			listener(this.state)
		}
	}

	onChange(listener: Listener): void {
		this.#listeners.add(listener)
	}

	/** Open the drawer when the block is a drawer kick pulse. */
	handleBlock(block: ParsedEscPosBlock): void {
		if (block.type !== 'command') {
			return
		}
		if (
			block.name === 'Generate Pulse' ||
			(block.name === 'Real-Time Command' && block.details?.fn === 1)
		) {
			this.set(true)
		}
	}
}
