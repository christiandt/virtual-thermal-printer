import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isSea } from 'node:sea'
import { DEFAULT_CERT_PATH, DEFAULT_KEY_PATH } from './https.js'
import { startPrinter } from './server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const appVersion = (() => {
	if (isSea()) {
		return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown'
	}
	try {
		const pkgJson = JSON.parse(
			readFileSync(join(__dirname, 'package.json'), 'utf-8'),
		)
		if (typeof pkgJson.version === 'string') {
			return pkgJson.version
		}
	} catch (event) {
		console.error(
			'Failed to read app version from package.json:',
			event instanceof Error ? event.message : event,
		)
	}
	return 'unknown'
})()
console.log(`App version: ${appVersion}`)

const { values: flags } = parseArgs({
	args: process.argv.slice(2),
	options: {
		http: { type: 'string', default: '80' },
		socket: { type: 'string', default: '9100' },
		// HTTPS is off unless a port is given.
		https: { type: 'string' },
		cert: { type: 'string', default: DEFAULT_CERT_PATH },
		key: { type: 'string', default: DEFAULT_KEY_PATH },
	},
})

function validatePort(portValue: string | number, portName: string): number {
	const port = typeof portValue === 'string' ? parseInt(portValue) : portValue
	if (isNaN(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid ${portName} port.`)
	}
	return port
}

const httpPort = validatePort(flags['http'] ?? '80', 'HTTP')
const socketPort = validatePort(flags['socket'] ?? '9100', 'Socket')
const httpsPort = flags['https'] === undefined ? null : validatePort(flags['https'], 'HTTPS')

startPrinter({
	httpPort,
	socketPort,
	httpsPort,
	certPath: flags['cert'],
	keyPath: flags['key'],
	version: appVersion,
}).catch((error) => {
	// E.g. a port already in use.
	console.error(`Could not start the printer: ${error instanceof Error ? error.message : error}`)
	process.exit(1)
})
