// Bundles the desktop app's main process (with the printer server) into one
// CommonJS file. With --package it builds the installers in release/; with
// --package --dir only an unpacked app for this machine, to try it quickly.
// The app takes the printer package's version, so `npm run version:bump`
// stays the only place to change it.
import * as esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const printerDir = join(here, '..', 'virtual-thermal-printer')
const { version } = JSON.parse(await readFile(join(printerDir, 'package.json'), 'utf-8'))

if (!existsSync(join(printerDir, 'dist', 'index.html'))) {
	console.error('The web interface is not built: run `npm run build` in the repository root first.')
	process.exit(1)
}

await esbuild.build({
	entryPoints: [join(here, 'main.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	outfile: join(here, 'dist', 'main.cjs'),
	external: ['electron'],
	// Use the decoder's TypeScript sources, as the printer's own tests do.
	conditions: ['source'],
	define: {
		// import.meta.url does not exist in CommonJS; the server reads it.
		'import.meta.url': '__importMetaUrl',
		__APP_VERSION__: JSON.stringify(version),
	},
	banner: {
		js: "var __importMetaUrl = require('url').pathToFileURL(__filename).href;",
	},
	logLevel: 'warning',
})
console.log(`Bundled the desktop app (version ${version}).`)

if (process.argv.includes('--package')) {
	const { build, Platform, Arch } = await import('electron-builder')
	await build({
		projectDir: here,
		targets: process.argv.includes('--dir')
			? Platform.current().createTarget('dir', Arch[process.arch])
			: undefined,
		publish: 'never',
		config: {
			appId: 'io.github.christiandt.virtual-thermal-printer',
			productName: 'Virtual Thermal Printer',
			artifactName: 'virtual-thermal-printer-desktop-${version}-${os}-${arch}.${ext}',
			extraMetadata: { version },
			directories: { output: 'release', buildResources: 'build' },
			files: ['dist/**', 'package.json'],
			// The web interface, served by the printer from the app's resources.
			extraResources: [{ from: join(printerDir, 'dist'), to: 'web' }],
			mac: {
				category: 'public.app-category.developer-tools',
				target: [
					{ target: 'dmg', arch: ['arm64', 'x64'] },
					{ target: 'zip', arch: ['arm64', 'x64'] },
				],
				// Not signed with a Developer ID yet: ad-hoc signature only.
				identity: null,
			},
			win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }] },
			portable: { artifactName: 'virtual-thermal-printer-desktop-${version}-win-portable-${arch}.${ext}' },
			linux: { category: 'Development', target: [{ target: 'AppImage', arch: ['x64'] }] },
		},
	})
}
