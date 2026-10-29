// HTTPS, as on a TM printer: the printer serves ePOS-Print over HTTPS with its
// own self-signed certificate, and a POS served over HTTPS can only reach it
// that way (browsers block mixed content). The browser has to accept that
// certificate once, as it would for a real printer.
//
// The certificate is read from --cert/--key. When the files do not exist yet,
// a self-signed one is generated and written there, so the browser's
// acceptance survives restarts. It names localhost and this machine's host
// name and network addresses, so the POS can reach it by IP like a printer on
// the shop network.
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import selfsigned from 'selfsigned'

export const DEFAULT_CERT_PATH = join(homedir(), '.virtual-thermal-printer', 'https-cert.pem')
export const DEFAULT_KEY_PATH = join(homedir(), '.virtual-thermal-printer', 'https-key.pem')

/** Generated certificates are valid this long. */
const CERTIFICATE_DAYS = 825

export interface Certificate {
	cert: string
	key: string
	/** SHA-256 fingerprint, as browsers show it. */
	fingerprint: string
	/** Host names and addresses the certificate is valid for. */
	names: string[]
	generated: boolean
}

/** The names a generated certificate covers. */
export function certificateNames(): { dns: string[]; ips: string[] } {
	const host = hostname()
	const dns = [...new Set(['localhost', host, host.endsWith('.local') ? host : `${host}.local`])]
	const ips = ['127.0.0.1', '::1']
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			// Link-local IPv6 addresses only work with an interface named, which
			// no browser URL to a printer has.
			const linkLocal = address.family === 'IPv6' && /^fe[89ab]/i.test(address.address)
			if (!address.internal && !linkLocal && !ips.includes(address.address)) ips.push(address.address)
		}
	}
	return { dns, ips }
}

export function generateCertificate(): { cert: string; key: string } {
	const { dns, ips } = certificateNames()
	const pems = selfsigned.generate([{ name: 'commonName', value: 'Virtual Thermal Printer' }], {
		days: CERTIFICATE_DAYS,
		keySize: 2048,
		algorithm: 'sha256',
		extensions: [
			{ name: 'basicConstraints', cA: false },
			{ name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
			{ name: 'extKeyUsage', serverAuth: true },
			{
				name: 'subjectAltName',
				altNames: [
					...dns.map((value) => ({ type: 2, value })),
					...ips.map((ip) => ({ type: 7, ip })),
				],
			},
		],
	})
	return { cert: pems.cert, key: pems.private }
}

/** Read the certificate, or generate and save one when either file is missing. */
export function loadOrCreateCertificate(certPath: string, keyPath: string): Certificate {
	let generated = false
	if (!existsSync(certPath) || !existsSync(keyPath)) {
		const { cert, key } = generateCertificate()
		for (const [path, contents] of [[certPath, cert], [keyPath, key]]) {
			mkdirSync(dirname(path), { recursive: true })
			writeFileSync(path, contents, { mode: 0o600 })
		}
		generated = true
	}
	const cert = readFileSync(certPath, 'utf-8')
	const key = readFileSync(keyPath, 'utf-8')
	const x509 = new X509Certificate(cert)
	const names = (x509.subjectAltName ?? '')
		.split(', ')
		.map((name) => name.replace(/^(DNS|IP Address):/, ''))
		.filter(Boolean)
	return { cert, key, fingerprint: x509.fingerprint256, names, generated }
}
