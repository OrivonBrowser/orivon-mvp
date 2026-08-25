// GATE 1b -- main side. TCP broker (from gate 1a) plus a UDP broker.
//
// Same scope line as gate 1a: NO capability check happens here. The real
// broker checks, and checkConnect(manifest, hostArg, resolveFn) against an
// injected stub resolver is its first unit test (build step 2).
//
// Throwaway.
const path = require('node:path')
const net = require('node:net')
const dgram = require('node:dgram')
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

  // ---- TCP -----------------------------------------------------------------
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

  // ---- UDP -----------------------------------------------------------------
  ipcMain.handle('dgram:create', (_event, { id, type }) => {
    const { port1, port2 } = new MessageChannelMain()
    const socket = dgram.createSocket(type === 'udp6' ? 'udp6' : 'udp4')

    let open = true
    const post = (msg) => { if (open) { try { port1.postMessage(msg) } catch { /* closed */ } } }

    socket.on('listening', () => post({ t: 'listening', addr: socket.address() }))
    socket.on('message', (msg, rinfo) => {
      if (process.env.SPIKE_DEBUG) console.error(`[broker] udp recv ${msg.length}B from ${rinfo.address}:${rinfo.port}`)
      post({ t: 'message', b: new Uint8Array(msg), rinfo })
    })
    socket.on('error', (err) => post({ t: 'error', m: err.message }))
    socket.on('close', () => {
      post({ t: 'close' })
      open = false
      try { port1.close() } catch { /* already closed */ }
    })

    port1.on('message', (event) => {
      const m = event.data
      if (m.t === 'bind') {
        if (process.env.SPIKE_DEBUG) console.error(`[broker] udp bind port=${m.port} addr=${m.address}`)
        if (m.address) socket.bind(m.port, m.address)
        else socket.bind(m.port)
      } else if (m.t === 'send' && m.b) {
        if (process.env.SPIKE_DEBUG) {
          console.error(`[broker] udp send ${m.b.length}B -> ${m.address}:${m.port}`)
        }
        socket.send(Buffer.from(m.b), m.port, m.address, (err) => {
          if (err) {
            if (process.env.SPIKE_DEBUG) console.error(`[broker] udp send ERROR ${err.message}`)
            post({ t: 'error', m: err.message })
          }
        })
      } else if (m.t === 'close') {
        try { socket.close() } catch { /* already closed */ }
      }
    })
    port1.start()

    win.webContents.postMessage('dgram:port', { id }, [port2])
    return true
  })

  win.loadFile(path.join(__dirname, 'dist', 'index.html'))
  return win
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
