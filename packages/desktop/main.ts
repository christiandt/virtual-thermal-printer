// The virtual thermal printer as a desktop app: the printer runs in this
// process and a window shows its web interface, with the address to point a
// POS at. If a port is taken (another printer, a Docker container), the next
// free one is used; the window title and the panel show the one in use.
import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { startPrinter, type RunningPrinter } from '../virtual-thermal-printer/server.js'

declare const __APP_VERSION__: string

/** How many ports to try, counting up from the defaults. */
const PORT_ATTEMPTS = 20

let printer: RunningPrinter | null = null
let mainWindow: BrowserWindow | null = null

function baseUrl(): string {
	return `http://localhost:${printer!.httpPort}`
}

async function start(): Promise<void> {
	const userData = app.getPath('userData')
	try {
		printer = await startPrinter({
			httpPort: 8000,
			socketPort: 9100,
			httpsPort: 8443,
			portAttempts: PORT_ATTEMPTS,
			// The certificate lives with the app, so it is accepted once.
			certPath: join(userData, 'https-cert.pem'),
			keyPath: join(userData, 'https-key.pem'),
			staticRoot: app.isPackaged
				? join(process.resourcesPath, 'web')
				: join(__dirname, '..', '..', 'virtual-thermal-printer', 'dist'),
			version: __APP_VERSION__,
		})
	} catch (error) {
		dialog.showErrorBox(
			'The virtual thermal printer could not start',
			error instanceof Error ? error.message : String(error),
		)
		app.quit()
		return
	}
	createWindow()
}

function createWindow(): void {
	const window = new BrowserWindow({
		width: 560,
		height: 900,
		minWidth: 360,
		title: `Virtual Thermal Printer — ${baseUrl()}`,
		backgroundColor: '#121212',
		webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
	})
	mainWindow = window
	// Keep the address in the title rather than the page's own.
	window.on('page-title-updated', (event) => event.preventDefault())
	// Links leave the app for the system browser.
	window.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url)
		return { action: 'deny' }
	})
	window.webContents.on('will-navigate', (event, url) => {
		if (!url.startsWith(baseUrl())) {
			event.preventDefault()
			void shell.openExternal(url)
		}
	})
	window.on('closed', () => {
		mainWindow = null
	})
	void window.loadURL(`${baseUrl()}/`)
}

// One printer per machine: a second launch shows the first one's window.
if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on('second-instance', () => {
		if (!mainWindow) return
		if (mainWindow.isMinimized()) mainWindow.restore()
		mainWindow.focus()
	})
	app.whenReady().then(start)
	// The printer lives as long as its window, on macOS too: a printer
	// running with no window would be easy to forget.
	app.on('window-all-closed', () => app.quit())
	app.on('before-quit', () => {
		void printer?.close()
	})
}
