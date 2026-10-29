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

	it('ignores commented-out elements', () => {
		const job = parseEposRequest(envelope('<!-- <pulse/> --><text>Hi</text><!--<cut/>-->'))
		expect(job?.bytes.includes(0x70)).toBe(false)
		expect([...job!.bytes].slice(-2)).toEqual([0x48, 0x69])
	})

	it('builds dw/dh on the size a raw command left', () => {
		const job = parseEposRequest(envelope(
			'<text width="3"/><command>1b40</command><text dh="true"/>' +
			'<command>1d2110</command><text dh="true"/>',
		))
		expect([...job!.bytes]).toEqual([
			0x1d, 0x21, 0x20,
			0x1b, 0x40,
			0x1d, 0x21, 0x01, // reset to 1×1, then double height
			0x1d, 0x21, 0x10,
			0x1d, 0x21, 0x11, // double width kept, double height added
		])
	})

	it('prints CDATA literally and never runs markup inside it', async () => {
		const job = parseEposRequest(envelope('<text><![CDATA[</text><pulse/> A & B]]></text>'))
		expect(Buffer.from(job!.bytes).includes(Buffer.from([0x1b, 0x70]))).toBe(false)
		const blocks = await decode(job!.bytes)
		const text = blocks.flatMap((b) => (b.type === 'text' ? [b.content] : [])).join('')
		expect(text).toBe('</text><pulse/> A & B')
	})

	it('reads "1" as true for boolean attributes', () => {
		const job = parseEposRequest(envelope('<text em="1" ul="1" reverse="1" dw="1" dh="1"/>'))
		expect([...job!.bytes]).toEqual([
			0x1b, 0x45, 1,
			0x1b, 0x2d, 1,
			0x1d, 0x42, 1,
			0x1d, 0x21, 0x11,
		])
	})

	it('rejects a request that is not well formed', () => {
		expect(parseEposRequest(envelope('<text>unclosed'))).toBeNull()
	})

	it('reads elements with a namespace prefix', () => {
		const body = envelope('').replace(/<epos-print xmlns="([^"]+)"><\/epos-print>/, '<e:epos-print xmlns:e="$1"><e:feed/></e:epos-print>')
		expect([...parseEposRequest(body)!.bytes]).toEqual([0x0a])
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

	it('translates a QR <symbol> into the GS ( k sequence', () => {
		const job = parseEposRequest(envelope('<symbol type="qrcode_model_2" level="level_q" width="6">AB</symbol>'))
		expect([...job!.bytes]).toEqual([
			0x1d, 0x28, 0x6b, 4, 0, 49, 65, 50, 0, // model 2
			0x1d, 0x28, 0x6b, 3, 0, 49, 67, 6, // 6-dot modules
			0x1d, 0x28, 0x6b, 3, 0, 49, 69, 50, // level Q
			0x1d, 0x28, 0x6b, 5, 0, 49, 80, 48, 0x41, 0x42, // store "AB"
			0x1d, 0x28, 0x6b, 3, 0, 49, 81, 48, // print
		])
		expect(job?.unsupported).toEqual([])
	})

	it('uses 3-dot modules and level M by default, and decodes entities in the data', () => {
		const job = parseEposRequest(envelope('<symbol type="qrcode_model_1">a?b=1&amp;c=2</symbol>'))
		const bytes = [...job!.bytes]
		expect(bytes.slice(0, 9)).toEqual([0x1d, 0x28, 0x6b, 4, 0, 49, 65, 49, 0])
		expect(bytes.slice(9, 17)).toEqual([0x1d, 0x28, 0x6b, 3, 0, 49, 67, 3])
		expect(bytes.slice(17, 25)).toEqual([0x1d, 0x28, 0x6b, 3, 0, 49, 69, 49])
		expect(Buffer.from(bytes.slice(33, -8)).toString()).toBe('a?b=1&c=2')
	})

	it('decodes a QR <symbol> into a QR image that carries its data', async () => {
		const link = 'https://shop.example/club/join?src=receipt'
		const job = parseEposRequest(envelope(`<text align="center"/><symbol type="qrcode_model_2" level="level_m" width="6" height="0" size="0">${link}</symbol>`))
		const blocks = await decode(job!.bytes)
		const image = blocks.find((block) => block.type === 'image')
		expect(image).toMatchObject({ type: 'image', symbolData: link, alignment: 1 })
	})

	it('reports symbol types it does not draw', () => {
		const job = parseEposRequest(envelope('<symbol type="pdf417_standard">x</symbol><text>y</text>'))
		expect(job?.unsupported).toEqual(['symbol (pdf417_standard)'])
		expect(job?.bytes.at(-1)).toBe(0x79)
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
