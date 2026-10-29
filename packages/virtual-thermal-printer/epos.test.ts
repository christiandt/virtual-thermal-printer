import { describe, it, expect } from 'vitest'
import { EscPosTransformer } from 'escpos-decoder'
import type { ParsedEscPosBlock } from 'escpos-decoder/types'
import { eposResponse, parseEposRequest } from './epos.js'

function envelope(body: string, header = ''): string {
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
		header +
		'<s:Body>' +
		`<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">${body}</epos-print>` +
		'</s:Body></s:Envelope>'
	)
}

async function decode(bytes: Uint8Array): Promise<ParsedEscPosBlock[]> {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes)
			controller.close()
		},
	})
	const blocks: ParsedEscPosBlock[] = []
	const reader = stream.pipeThrough(new TransformStream(new EscPosTransformer())).getReader()
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		blocks.push(value)
	}
	return blocks
}

describe('parseEposRequest', () => {
	it('rejects a body without <epos-print>', () => {
		expect(parseEposRequest('<foo/>')).toBeNull()
	})

	it('reads an empty job as a status request', () => {
		for (const body of [
			envelope(''),
			envelope('').replace(/><\/epos-print>/, '/>'),
		]) {
			const job = parseEposRequest(body)
			expect(job?.isStatusRequest).toBe(true)
			expect(job?.bytes.length).toBe(0)
		}
	})

	it('passes <command> hex through as raw ESC/POS', () => {
		const job = parseEposRequest(envelope('<command>1b40 1b 61 01</command>'))
		expect(job?.isStatusRequest).toBe(false)
		expect([...job!.bytes]).toEqual([0x1b, 0x40, 0x1b, 0x61, 0x01])
	})

	it('translates text attributes and content', () => {
		const job = parseEposRequest(envelope(
			'<text lang="en"/>' +
			'<text align="center"/>' +
			'<text em="true" dw="true" dh="true"/>' +
			'<text>A &amp; B&#10;</text>' +
			'<text em="false" dw="false" dh="false"/>',
		))
		expect([...job!.bytes]).toEqual([
			0x1b, 0x61, 0x01, // align center
			0x1b, 0x45, 0x01, // emphasized
			0x1d, 0x21, 0x11, // double width and height
			0x1b, 0x74, 16, // WPC1252
			0x41, 0x20, 0x26, 0x20, 0x42, 0x0a, // "A & B\n"
			0x1b, 0x45, 0x00,
			0x1d, 0x21, 0x00,
		])
	})

	it('prints text the decoder reads back, with Nordic letters', async () => {
		const job = parseEposRequest(envelope('<text>Blåbær, smørbrød, Ölmalm&#10;</text>'))
		const blocks = await decode(job!.bytes)
		const text = blocks.flatMap((b) => (b.type === 'text' ? [b.content] : [])).join('')
		expect(text).toBe('Blåbær, smørbrød, Ölmalm\n')
	})

	it('prints characters outside the code page as ?', async () => {
		const job = parseEposRequest(envelope('<text>Dvořák</text>'))
		const blocks = await decode(job!.bytes)
		const text = blocks.flatMap((b) => (b.type === 'text' ? [b.content] : [])).join('')
		expect(text).toBe('Dvo?ák')
	})

	it('selects the code table again after a raw command', async () => {
		const job = parseEposRequest(envelope('<text>A</text><command>1b40</command><text>ø</text>'))
		const blocks = await decode(job!.bytes)
		const text = blocks.flatMap((b) => (b.type === 'text' ? [b.content] : [])).join('')
		expect(text).toBe('Aø')
	})

	it('translates a very long text element', () => {
		const job = parseEposRequest(envelope(`<text>${'x'.repeat(200_000)}</text>`))
		expect(job?.bytes.length).toBe(3 + 200_000)
	})

	it('keeps the character size across elements', () => {
		const job = parseEposRequest(envelope('<text width="3"/><text dh="true"/>'))
		expect([...job!.bytes]).toEqual([0x1d, 0x21, 0x20, 0x1d, 0x21, 0x21])
	})

	it('translates feed, cut and pulse', () => {
		const job = parseEposRequest(envelope(
			'<feed/><feed line="3"/><feed unit="30"/>' +
			'<cut type="feed"/><cut type="no_feed"/>' +
			'<pulse/><pulse drawer="drawer_2" time="pulse_200"/>',
		))
		expect([...job!.bytes]).toEqual([
			0x0a,
			0x1b, 0x64, 3,
			0x1b, 0x4a, 30,
			0x1d, 0x56, 0x42, 0x00,
			0x1d, 0x56, 0x01,
			0x1b, 0x70, 0, 50, 100,
			0x1b, 0x70, 1, 100, 200,
		])
	})

	it('decodes a pulse as Generate Pulse', async () => {
		const job = parseEposRequest(envelope('<pulse drawer="drawer_1" time="pulse_100"/>'))
		const blocks = await decode(job!.bytes)
		expect(blocks).toContainEqual(expect.objectContaining({ type: 'command', name: 'Generate Pulse' }))
	})

	it('reports unsupported elements and still prints the rest', () => {
		const job = parseEposRequest(envelope('<barcode type="ean13">4901234567894</barcode><text>x</text>'))
		expect(job?.unsupported).toEqual(['barcode'])
		expect(job?.bytes.at(-1)).toBe(0x78)
	})

	it('reads the print job id from the SOAP header', () => {
		const header =
			'<s:Header><parameter xmlns="http://www.epson-pos.com/schemas/2011/03/eposprint">' +
			'<devid>local_printer</devid><printjobid>job-7</printjobid></parameter></s:Header>'
		expect(parseEposRequest(envelope('', header))?.printJobId).toBe('job-7')
	})
})

describe('eposResponse', () => {
	it('carries the status and the print job id', () => {
		const response = eposResponse(6, 'job-7')
		expect(response).toContain('success="true"')
		expect(response).toContain('status="6"')
		expect(response).toContain('printjobid="job-7"')
	})

	it('leaves out the print job id when the request had none', () => {
		expect(eposResponse(2, null)).not.toContain('printjobid')
	})
})
