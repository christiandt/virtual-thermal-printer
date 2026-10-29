// Epson ePOS-Print (XML over HTTP).
//
// A print job is a SOAP envelope whose <epos-print> body holds print elements:
// <text>, <feed>, <cut>, <pulse>, ... (what the Epson ePOS SDKs and most POS
// software send), or raw ESC/POS bytes in hex inside <command>. The elements
// are translated to the ESC/POS bytes a TM printer would execute, so both kinds
// of job go through the same decoder. An <epos-print> without elements prints
// nothing: it is how clients read the printer's status.
import iconv from 'iconv-lite'

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

// Text is sent in WPC1252 (ESC t 16), which TM printers carry and which
// covers the Western European letters; anything outside it prints as '?'.
const CODE_TABLE_WPC1252 = 16
const TEXT_ENCODING = 'windows-1252'

// ASB (automatic status back) bits of the response's `status` attribute.
export const ASB_PRINT_SUCCESS = 0x00000002
export const ASB_DRAWER_KICK = 0x00000004

export interface EposJob {
	/** The job as ESC/POS bytes; empty for a status request. */
	bytes: Uint8Array
	/** True when the job has no print elements (a status request). */
	isStatusRequest: boolean
	/** The <printjobid> from the SOAP header, echoed in the response. */
	printJobId: string | null
	/** Elements that were skipped because they are not supported. */
	unsupported: string[]
}

const XML_ENTITIES: Record<string, string> = {
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	amp: '&',
}

function decodeXmlText(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (_, entity: string) => {
		if (entity[0] === '#') {
			const codePoint = entity[1] === 'x' || entity[1] === 'X'
				? parseInt(entity.slice(2), 16)
				: parseInt(entity.slice(1), 10)
			return String.fromCodePoint(codePoint)
		}
		return XML_ENTITIES[entity.toLowerCase()]
	})
}

function parseAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {}
	for (const match of source.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
		attributes[match[1]] = decodeXmlText(match[2] ?? match[3] ?? '')
	}
	return attributes
}

interface XmlElement {
	/** Local name, without a namespace prefix. */
	name: string
	attributes: Record<string, string>
	children: (XmlElement | string)[]
}

function localName(name: string): string {
	return name.slice(name.indexOf(':') + 1)
}

/** A small XML reader: elements, attributes, text, CDATA and entities;
 *  comments, processing instructions and declarations are skipped. Null when
 *  the document is not well formed. */
function parseXml(source: string): XmlElement | null {
	const root: XmlElement = { name: '', attributes: {}, children: [] }
	const stack = [root]
	const addText = (text: string) => {
		if (text) stack[stack.length - 1].children.push(text)
	}
	let i = 0
	while (i < source.length) {
		const lt = source.indexOf('<', i)
		if (lt === -1) {
			addText(decodeXmlText(source.slice(i)))
			break
		}
		addText(decodeXmlText(source.slice(i, lt)))
		const skipTo = (terminator: string, from: number): number => {
			const end = source.indexOf(terminator, from)
			return end === -1 ? -1 : end + terminator.length
		}
		if (source.startsWith('<!--', lt)) {
			i = skipTo('-->', lt + 4)
		} else if (source.startsWith('<![CDATA[', lt)) {
			const end = source.indexOf(']]>', lt + 9)
			if (end !== -1) addText(source.slice(lt + 9, end))
			i = end === -1 ? -1 : end + 3
		} else if (source.startsWith('<?', lt)) {
			i = skipTo('?>', lt + 2)
		} else if (source.startsWith('<!', lt)) {
			i = skipTo('>', lt + 2)
		} else {
			// The tag runs to the first '>' outside a quoted attribute value.
			let end = lt + 1
			let quote = ''
			for (; end < source.length; end++) {
				const c = source[end]
				if (quote) {
					if (c === quote) quote = ''
				} else if (c === '"' || c === "'") {
					quote = c
				} else if (c === '>') {
					break
				}
			}
			if (end >= source.length) return null
			const tag = source.slice(lt + 1, end)
			i = end + 1
			if (tag.startsWith('/')) {
				const open = stack.pop()
				if (stack.length === 0 || open?.name !== localName(tag.slice(1).trim())) return null
				continue
			}
			const selfClosing = tag.endsWith('/')
			const match = (selfClosing ? tag.slice(0, -1) : tag).match(/^([^\s/]+)([\s\S]*)$/)
			if (!match) return null
			const element: XmlElement = {
				name: localName(match[1]),
				attributes: parseAttributes(match[2]),
				children: [],
			}
			stack[stack.length - 1].children.push(element)
			if (!selfClosing) stack.push(element)
		}
		if (i === -1) return null
	}
	return stack.length === 1 ? root : null
}

function findElement(element: XmlElement, name: string): XmlElement | null {
	for (const child of element.children) {
		if (typeof child === 'string') continue
		if (child.name === name) return child
		const found = findElement(child, name)
		if (found) return found
	}
	return null
}

function textContent(element: XmlElement): string {
	return element.children
		.map((child) => (typeof child === 'string' ? child : textContent(child)))
		.join('')
}

/** ePOS-Print booleans: "true" or "1". */
function flag(value: string): number {
	return value === 'true' || value === '1' ? 1 : 0
}

function byte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)))
}

/** Parse an ePOS-Print request; null when it holds no <epos-print> element. */
export function parseEposRequest(body: string): EposJob | null {
	const document = parseXml(body)
	const eposPrint = document && findElement(document, 'epos-print')
	if (!document || !eposPrint) {
		return null
	}
	const jobIdElement = findElement(document, 'printjobid')
	const printJobId = (jobIdElement && textContent(jobIdElement).trim()) || null

	const out: number[] = []
	const unsupported: string[] = []
	let elementCount = 0
	let selectedCodeTable = false
	// Character size persists across <text> elements, as on the printer.
	let width = 1
	let height = 1

	for (const element of eposPrint.children) {
		if (typeof element === 'string') continue
		elementCount++
		const a = element.attributes
		const content = textContent(element)
		switch (element.name) {
			case 'text': {
				if (a.align in ALIGNMENTS) out.push(ESC, 0x61, ALIGNMENTS[a.align])
				if (a.font in FONTS) out.push(ESC, 0x4d, FONTS[a.font])
				if (a.em) out.push(ESC, 0x45, flag(a.em))
				if (a.ul) out.push(ESC, 0x2d, flag(a.ul))
				if (a.reverse) out.push(GS, 0x42, flag(a.reverse))
				if (a.linespc) out.push(ESC, 0x33, byte(Number(a.linespc)))
				if (a.width || a.height || a.dw || a.dh) {
					if (a.width) width = Number(a.width)
					if (a.height) height = Number(a.height)
					if (a.dw) width = flag(a.dw) + 1
					if (a.dh) height = flag(a.dh) + 1
					width = Math.max(1, Math.min(8, width || 1))
					height = Math.max(1, Math.min(8, height || 1))
					out.push(GS, 0x21, ((width - 1) << 4) | (height - 1))
				}
				const text = content
				if (text) {
					if (!selectedCodeTable) {
						out.push(ESC, 0x74, CODE_TABLE_WPC1252)
						selectedCodeTable = true
					}
					// Byte by byte: spreading a long text into push() would exceed
					// the engine's argument limit.
					for (const b of iconv.encode(text, TEXT_ENCODING)) out.push(b)
				}
				break
			}
			case 'feed':
				if (a.line) out.push(ESC, 0x64, byte(Number(a.line)))
				else if (a.unit) out.push(ESC, 0x4a, byte(Number(a.unit)))
				else out.push(LF)
				break
			case 'cut':
				// "feed" (the default) and "reserve" feed to the cutter first.
				if (a.type === 'no_feed') out.push(GS, 0x56, 0x01)
				else out.push(GS, 0x56, 0x42, 0x00)
				break
			case 'pulse': {
				// ESC p m t1 t2: on for t1 × 2 ms, off for t2 × 2 ms.
				const ms = Number(a.time?.match(/^pulse_(\d+)$/)?.[1] ?? 100)
				out.push(ESC, 0x70, a.drawer === 'drawer_2' ? 1 : 0, byte(ms / 2), byte(ms))
				break
			}
			case 'command': {
				const hex = content.replace(/\s+/g, '')
				const raw: number[] = []
				for (let i = 0; i + 1 < hex.length; i += 2) {
					raw.push(parseInt(hex.slice(i, i + 2), 16))
				}
				for (const b of raw) out.push(b)
				// Raw bytes may reset the printer (ESC @) or select another code
				// table, so the next text selects WPC1252 again; and they may
				// change the character size the next dw/dh builds on.
				selectedCodeTable = false
				;[width, height] = characterSizeAfter(raw, width, height)
				break
			}
			default:
				unsupported.push(element.name)
		}
	}

	return {
		bytes: new Uint8Array(out),
		isStatusRequest: elementCount === 0,
		printJobId,
		unsupported,
	}
}

/** The character size after raw ESC/POS bytes: ESC @ resets it, GS ! and
 *  ESC ! set it. A byte scan, so image or barcode data that happens to hold
 *  these sequences can mislead it. */
function characterSizeAfter(bytes: number[], width: number, height: number): [number, number] {
	for (let i = 0; i + 1 < bytes.length; i++) {
		if (bytes[i] === ESC && bytes[i + 1] === 0x40) {
			width = 1
			height = 1
		} else if (bytes[i] === GS && bytes[i + 1] === 0x21 && i + 2 < bytes.length) {
			width = (bytes[i + 2] >> 4) + 1
			height = (bytes[i + 2] & 0x0f) + 1
		} else if (bytes[i] === ESC && bytes[i + 1] === 0x21 && i + 2 < bytes.length) {
			width = bytes[i + 2] & 0x20 ? 2 : 1
			height = bytes[i + 2] & 0x10 ? 2 : 1
		}
	}
	return [width, height]
}

const ALIGNMENTS: Record<string, number> = { left: 0, center: 1, right: 2 }
const FONTS: Record<string, number> = { font_a: 0, font_b: 1, font_c: 2 }

export function eposResponse(status: number, printJobId: string | null): string {
	const jobId = printJobId === null ? '' : ` printjobid="${printJobId.replace(/[^\w-]/g, '')}"`
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
		`<response xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print" success="true" code="" status="${status}" batterystatus="0"${jobId} />` +
		'</s:Body></s:Envelope>'
	)
}
