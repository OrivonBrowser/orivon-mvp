// GATE 4 -- main side. The broker, unchanged from gate 1a's proven-working
// structure (deliberately -- gate 3 hit an unresolved Playwright attach issue
// after diverging further from this shape, so gate 4 stays close to it).
//
// Real Node sockets live here; the renderer gets one MessageChannelMain port
// per socket, exactly as capability-api.md SS Throughput specifies.
//
// NOTE: this spike broker performs NO capability check. The real one does --
// that is build step 2, and checkConnect(manifest, hostArg, resolveFn) with an
// injected resolver is its first unit test. The line is drawn here so nobody
// mistakes this file for a design.
//
// Throwaway.
const path = require('node:path')
const net = require('node:net')
const { app, BrowserWindow, MessageChannelMain, ipcMain } = require('electron')

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
