# Virtual Thermal Printer

A web-based virtual thermal printer that simulates a real ESC/POS and Epson EPOS
printer. This tool is designed for developers who need to test point-of-sale
(POS) applications without a physical printer.

## Features

- **Epson EPOS Support:** Receives and processes Epson EPOS commands via an HTTP endpoint.
- **ESC/POS Support:** Receives and processes raw ESC/POS commands via a TCP socket.
- **Web-Based Rendering:** Renders the print output in a real-time web interface.
- **Cash Drawer:** Simulates a drawer on the kick-out connector: pulses open it,
  the printer status reports it, and the web interface closes it.
- **Printer Conditions:** Cover open, paper out and paper low, set from the web
  interface and reported the way a TM printer does, and a slow or silent
  printer to test POS timeouts.
- **Job Log:** The last 100 print jobs as text over HTTP, for automated tests.
- **HTTPS:** Optional, with a generated self-signed certificate, as on a TM
  printer.

## Screenshots

Print jobs rendered in the web interface, laid out like on an 80 mm printer
(48 columns of Font A):

| Receipt | Formatting |
|---|---|
| <img src="docs/screenshots/receipt.png" alt="A sample café receipt with a centered header, item and price columns, a double-height total, a QR code and a reversed thank-you line" width="400"> | <img src="docs/screenshots/formatting.png" alt="Bold, underlined, reversed, double-width and double-height text, Font B, alignment, tab stops, line wrapping and an EAN-13 barcode" width="400"> |

## Packages

| Package | Description |
|---|---|
| [`escpos-decoder`](packages/escpos-decoder) | Transforms a stream of raw ESC/POS bytes into typed TypeScript blocks |
| [`virtual-thermal-printer`](packages/virtual-thermal-printer) | HTTP + WebSocket + TCP server with browser UI |
| [`desktop`](packages/desktop) | The printer as a desktop app (Electron) for macOS, Windows and Linux |

## Desktop App

Download the app for your system from the
[releases](https://github.com/christiandt/virtual-thermal-printer/releases) and
start it: the printer runs inside the app and its window shows the web
interface. Point your POS at the address under **Connect your POS** in the
panel (also in the window title): ePOS on `http://localhost:8000`, HTTPS on
`https://localhost:8443`, raw ESC/POS on `localhost:9100`. If a port is
already in use (another printer, a Docker container), the app takes the next
free one and shows that instead. Only one copy runs at a time; closing the
window stops the printer.

| System | Download | First start |
|---|---|---|
| macOS (Apple silicon / Intel) | `…-mac-arm64.dmg` / `…-mac-x64.dmg` (or `.zip`) | The app is not signed with an Apple Developer ID yet, so macOS refuses to open it. After moving it to Applications, run `xattr -dr com.apple.quarantine "/Applications/Virtual Thermal Printer.app"` once. |
| Windows | `…-win-x64.exe` (installer) or `…-win-portable-x64.exe` | SmartScreen warns about an unknown publisher: choose **More info → Run anyway**. |
| Linux | the `.AppImage` | `chmod +x` the file, then run it. |

The HTTPS certificate is generated on first start and kept with the app's
data, so it only has to be accepted once in the POS's browser.

To build it yourself, after `npm ci` and `npm run build` in the repository
root:

```bash
cd packages/desktop
npm ci
npm start          # run it from source
npm run pack       # an unpacked app for this machine, in release/
npm run dist       # the installers for this system, in release/
```

The desktop package has its own lockfile and is not part of the npm
workspace, so installing the printer does not download Electron.

## Local Development

Requires [Node.js](https://nodejs.org/) 22+.

```bash
git clone https://github.com/FilipChalupa/virtual-thermal-printer.git
cd virtual-thermal-printer
npm install
npm run dev
```

The server starts at `http://localhost:8000` and listens for raw ESC/POS on TCP port `9100`.

Both ports can be overridden:

```bash
./virtual-thermal-printer --http 8080 --socket 9100
```

### HTTPS

A TM printer serves ePOS-Print over HTTPS with its own self-signed
certificate, and a POS served over HTTPS can only reach it that way (browsers
block mixed content). To test that, give the simulator an HTTPS port too:

```bash
./virtual-thermal-printer --http 8000 --socket 9100 --https 8443
```

On first start it generates a self-signed certificate and saves it to
`~/.virtual-thermal-printer/https-cert.pem` and `https-key.pem` (or to
`--cert` / `--key`), so the browser's acceptance survives restarts. The
certificate names `localhost`, the host name and this machine's network
addresses, so a POS can reach the printer by IP as on a shop network; the log
prints them with the certificate's SHA-256 fingerprint. As with a real
printer, open `https://<address>:8443/` once in the POS's browser and accept
the certificate, or requests from the POS fail as if the printer were
unreachable. Delete the two files to get a new certificate, for example after
the machine's address has changed.

In Docker, map the port and pass the flag:

```bash
docker run --rm -p 8000:80 -p 9100:9100 -p 8443:443 virtual-thermal-printer npm start -- --https 443
```

A certificate generated inside the container names the container, not the
host, so it only matches `localhost`. To reach the printer by the host's
address, generate the certificate on the host (run the simulator there once
with `--https`) and mount it:
`-v ~/.virtual-thermal-printer:/root/.virtual-thermal-printer`.

## Sending Print Commands

> [!WARNING]
> The public server is shared among all users. Any print jobs you send will be
> visible to anyone currently viewing the page.

### Epson EPOS (HTTP)

> [!WARNING]
> The public server only supports Epson EPOS commands via HTTP. Raw ESC/POS
> commands over TCP are **not** supported on the public server and must be used
> with a locally running instance.

```bash
curl -X POST \
  -H "Content-Type: text/xml" \
  --data @packages/virtual-thermal-printer/fixtures/request1.xml \
  http://localhost:8000/cgi-bin/epos/service.cgi
```

Besides raw ESC/POS in `<command>`, the endpoint takes the print elements the
Epson ePOS SDKs send: `<text>` (with `align`, `em`, `ul`, `reverse`, `font`,
`width`, `height`, `dw`, `dh`, `linespc`), `<feed>`, `<cut>`, `<pulse>` and
QR codes as `<symbol type="qrcode_model_1|qrcode_model_2">` (with `level` and
`width`, the module size). Text is printed in code page WPC1252. Other
elements (`<image>`, `<barcode>`, other symbol types, …) are skipped and
logged. In the job log a QR code reads `[QR <its data>]`. A job without elements prints nothing and returns
the printer status, which is how clients poll it.

### Cash drawer

A drawer kick pulse opens the simulated cash drawer: `<pulse>` over ePOS,
`ESC p` or `DLE DC4 1` over either interface. The drawer stays open until it is
closed with the button in the bottom corner of the web interface, which can
also open it by hand. While it is open, ePOS responses set the
`ASB_DRAWER_KICK` bit (`0x4`) of `status`, the drawer sensor reading HIGH.

Most drawers' sensor reads HIGH while open; some read HIGH while closed, and
a POS must be set up for that. Choose "Sensor reads HIGH when … closed" in the
web interface (or `POST /drawer` with `{"sensorHighWhenOpen": false}`) to
simulate such a drawer: the `ASB_DRAWER_KICK` bit is then set while the drawer
is closed.

The drawer can also be read and set over HTTP, e.g. from tests:

```bash
curl http://localhost:8000/drawer              # {"type":"drawer","open":false,"sensorHighWhenOpen":true}
curl -X POST http://localhost:8000/drawer/open
curl -X POST http://localhost:8000/drawer/close
```

On the shared public server, everyone viewing the page shares the drawer.

### Printer conditions

The web interface can also open the printer cover, run it out of paper or set
the paper low, to test how a POS handles a printer that cannot print:

| Condition | ePOS response | Raw ESC/POS |
|---|---|---|
| Cover open | `success="false" code="EPTR_COVER_OPEN"`, status `ASB_OFF_LINE \| ASB_COVER_OPEN` | held until the cover is closed |
| Paper out | `success="false" code="EPTR_REC_EMPTY"`, status `ASB_OFF_LINE \| ASB_RECEIPT_END \| ASB_RECEIPT_NEAR_END` | held until paper is back |
| Paper low | prints; status adds `ASB_RECEIPT_NEAR_END` | prints |

The printer can also answer slowly, to test how a POS times out:

| Setting | Behaviour |
|---|---|
| `responseDelayMs` (0–60000) | every ePOS response, status requests included, waits this long after the job has run |
| `noResponse` | print jobs run but are never answered; the request is held until the client gives up. Status requests are still answered, so the POS gets as far as printing |

Either way the job prints at once, so a receipt can be on paper while the
POS is still waiting for, or has given up on, the answer. Both are set from
the "Answers" list in the web interface, or with `POST /printer`.

While off line the printer runs nothing from an ePOS job, a drawer pulse
included. Status requests (empty jobs) fail the same way, with the status
bits, so a POS can poll it. Over HTTP:

```bash
curl http://localhost:8000/printer
curl -X POST -H "Content-Type: application/json" \
  --data '{"coverOpen": true}' http://localhost:8000/printer
```

### ESC/POS (TCP Socket)

Connect to port `9100` and send raw ESC/POS bytes, e.g. via `netcat`:

```bash
echo -e "\x1b\x40Hello\x0a" | nc localhost 9100
```

### Print jobs (for tests)

The printer keeps its last 100 jobs, so automated tests can check what was
printed without looking at the page. An ePOS request is one job and a socket
connection is one job. Status requests are not jobs. A job refused while the
printer is off line is kept with `"printed": false` and its error code.

```bash
curl http://localhost:8000/jobs             # all jobs, oldest first
curl http://localhost:8000/jobs?since=12    # only jobs after job 12
curl http://localhost:8000/jobs/13          # one job, with its decoded blocks
curl -X DELETE http://localhost:8000/jobs   # forget them all
```

```json
[{ "id": 13, "source": "epos", "receivedAt": "2026-10-29T12:31:07.412Z",
   "printJobId": null, "printed": true, "errorCode": null,
   "text": "KOPI\nBårebukett          599,00\n\n\n", "cuts": 1, "drawerPulses": 0 }]
```

`text` is the printed text, with feeds as line breaks and images as
`[image W×H]`. `/jobs/:id` adds `blocks`, the decoded ESC/POS blocks with
alignment, size and emphasis, for checks on how something was printed.

## Docker

```bash
npm run docker:build
npm run docker:start
```

Or manually:

```bash
docker build -t virtual-thermal-printer .
docker run --rm -p 8000:80 -p 9100:9100 virtual-thermal-printer
```

The web UI is available at `http://localhost:8000` and the TCP socket on port `9100`.

## Releasing

1. Bump the version and create a git tag:
   ```bash
   npm run version:bump              # patch (0.0.x)
   npm run version:bump -- --part=minor  # minor (0.x.0)
   npm run version:bump -- --part=major  # major (x.0.0)
   ```
2. Push the tag to trigger the release workflow:
   ```bash
   git push && git push --tags
   ```

GitHub Actions then builds platform binaries and the desktop app (Linux, macOS, Windows) and a Docker image, and creates a GitHub Release.

The release is published with whatever was built, even if a build failed or
never got a runner (macOS runners are sometimes short); the run summary lists
what is missing. **Re-run failed jobs** on that run adds the missing files to
the same release.

From the Actions tab, **Run workflow** on *Release* without a tag is a dry run:
it builds everything and publishes nothing. With an existing tag it builds that
tag's code and creates or completes its release, using the workflow on the
branch it is started from. That is how a tag pushed before a workflow fix gets
released, since a tag push always runs the workflow of the tagged commit.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload on port 8000 |
| `npm run build` | Build `escpos-decoder` and the frontend |
| `npm test` | Run all tests across all packages |
| `npm run docker:build` | Build Docker image |
| `npm run docker:start` | Run Docker container |
| `npm run version:bump` | Bump patch version, commit and tag |

## License

[MIT](LICENSE)
