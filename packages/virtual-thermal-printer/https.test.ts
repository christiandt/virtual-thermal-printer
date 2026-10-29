import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { loadOrCreateCertificate } from './https.js'
import { eposJob, startServer, waitFor, type TestServer } from './test-server.js'

function httpsRequest(url: string, ca: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const req = request(url, { method, ca, headers: body ? { 'Content-Type': 'text/xml' } : {} }, (res) => {
			let text = ''
			res.on('data', (chunk) => (text += chunk))
			res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
		})
		req.on('error', reject)
		req.end(body)
	})
}

describe('loadOrCreateCertificate', () => {
	let dir: string

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'vtp-cert-'))
	})

	afterAll(() => rmSync(dir, { recursive: true, force: true }))

	it('generates a self-signed certificate for localhost and keeps it', () => {
		const certPath = join(dir, 'nested', 'cert.pem')
		const keyPath = join(dir, 'nested', 'key.pem')
		const first = loadOrCreateCertificate(certPath, keyPath)
		expect(first.generated).toBe(true)
		expect(first.names).toEqual(expect.arrayContaining(['localhost', '127.0.0.1']))
		expect(first.names.some((name) => /^FE[89AB]/i.test(name))).toBe(false)
		const x509 = new X509Certificate(readFileSync(certPath))
		expect(x509.checkHost('localhost')).toBe('localhost')
		expect(x509.checkIP('127.0.0.1')).toBe('127.0.0.1')
		expect(x509.verify(x509.publicKey)).toBe(true) // self-signed

		const second = loadOrCreateCertificate(certPath, keyPath)
		expect(second.generated).toBe(false)
		expect(second.fingerprint).toBe(first.fingerprint)
	})
})

describe('HTTPS', () => {
	let server: TestServer
	let dir: string
	let ca: string

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'vtp-https-'))
		const certPath = join(dir, 'cert.pem')
		server = await startServer({ https: { certPath, keyPath: join(dir, 'key.pem') } })
		ca = readFileSync(certPath, 'utf-8')
		await waitFor(async () => (await httpsRequest(`${server.httpsUrl}/health`, ca)).status === 200, 40)
	}, 30_000)

	afterAll(async () => {
		await server.stop()
		rmSync(dir, { recursive: true, force: true })
	})

	it('serves ePOS over HTTPS with the generated certificate', async () => {
		const response = await httpsRequest(`${server.httpsUrl}/cgi-bin/epos/service.cgi`, ca, 'POST', eposJob('<text>Over HTTPS</text>'))
		expect(response.status).toBe(200)
		expect(response.text).toContain('success="true"')
		const jobs = await (await fetch(`${server.baseUrl}/jobs`)).json()
		expect(jobs.at(-1)).toMatchObject({ text: 'Over HTTPS' })
	})

	it('is refused by a client that has not accepted the certificate', async () => {
		await expect(fetch(`${server.httpsUrl}/health`)).rejects.toThrow()
	})

	it('streams to the web interface over wss', async () => {
		const ws = new WebSocket(`${server.httpsUrl!.replace('https', 'wss')}/stream`, { ca })
		const message = await new Promise<{ type: string }>((resolve, reject) => {
			ws.once('message', (data) => resolve(JSON.parse(String(data))))
			ws.once('error', reject)
		})
		ws.close()
		expect(message.type).toBe('drawer')
	})

	it('keeps serving HTTP alongside', async () => {
		expect((await fetch(`${server.baseUrl}/health`)).ok).toBe(true)
	})
})
