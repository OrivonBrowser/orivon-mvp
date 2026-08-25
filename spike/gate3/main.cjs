// GATE 3 -- main side. TCP broker only (no DHT/UDP needed -- the fixture
// torrent is reached by explicit peer address against a local seeder).
//
// Same scope line as every other gate: NO capability check happens here.
// The real broker checks; checkConnect(manifest, hostArg, resolveFn) against
// an injected stub resolver is its first unit test (build step 2).
//
// Throwaway.
const path = require('node:path')
const net = require('node:net')
const { app, BrowserWindow, MessageChannelMain, ipcMain, protocol } = require('electron')

// Registered BEFORE app.whenReady() -- required by Electron for a privileged
// scheme. This is the fallback media path if service workers do not register
// under file://. `stream: true` is what lets the handler return a streaming
// Response; `secure: true` and `supportFetchAPI: true` are needed for a
// <video> element and fetch() to treat it as a normal origin.
protocol.registerSchemesAsPrivileged([{
  scheme: 'orivon-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
}])

function createWindow () {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  // Diagnostic hooks, left in place deliberately -- KNOWN ISSUE, see
  // spike/results/gate-3.json and the gate-3 devlog entry. Under a direct
  // (non-Playwright) launch, all of these fire normally and the page loads
  // fine. Under Playwright's `_electron.launch()` + `firstWindow()`, NONE of
  // them fire and firstWindow() times out after 30s, even though the app and
  // its bundle are unmodified between the two launch methods. The next person
  // touching this gate should keep these hooks rather than re-add them.
  win.webContents.on('did-finish-load', () => console.error('[main] did-finish-load'))
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error(`[main] did-fail-load ${code} ${desc}`))
  win.webContents.on('render-process-gone', (_e, details) => console.error('[main] render-process-gone: ' + JSON.stringify(details)))
  win.webContents.on('console-message', (_e, level, message) => console.error(`[renderer-console] ${level}: ${message}`))
  win.webContents.on('preload-error', (_e, preloadPath, error) => console.error(`[main] PRELOAD ERROR at ${preloadPath}: ${error.stack || error.message || error}`))
  win.webContents.on('dom-ready', () => console.error('[main] dom-ready'))

  ipcMain.handle('net:connect', (_event, { id, host, port }) => {
    const { port1, port2 } = new MessageChannelMain()
    const socket = net.connect({ host, port })
    socket.setNoDelay(true)

    let open = true
    const post = (msg) => { if (open) { try { port1.postMessage(msg) } catch { /* closed */ } } }

    socket.on('connect', () => post({ t: 'connect' }))
    socket.on('data', (chunk) => post({ t: 'data', b: new Uint8Array(chunk) }))
    socket.on('error', (err) => post({ t: 'error', m: err.message }))
    socket.on('end', () => post({ t: 'end' }))
    socket.on('close', () => {
      post({ t: 'close' })
      open = false
      try { port1.close() } catch { /* already closed */ }
    })

    port1.on('message', (event) => {
      const m = event.data
      if (m.t === 'write' && m.b) socket.write(Buffer.from(m.b))
      else if (m.t === 'end') socket.end()
      else if (m.t === 'destroy') socket.destroy()
    })
    port1.start()

    win.webContents.postMessage('net:port', { id }, [port2])
    return true
  })

  win.loadFile(path.join(__dirname, 'dist', 'index.html'))
  return win
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
