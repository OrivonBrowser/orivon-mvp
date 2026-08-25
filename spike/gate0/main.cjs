// GATE 0 -- main side.
//
// Question: does MessagePortMain carry bytes between a sandboxed renderer and
// the main process, intact, in both directions, and how fast?
//
// This matters because capability-api.md SS Throughput specifies exactly this
// mechanism for socket data, and electron#34905 (still open) reports that
// MessagePortMain.postMessage accepts only MessagePortMain in its transfer
// list -- which would mean transferable ArrayBuffers are UNAVAILABLE here, not
// merely unreliable. build-plan.md names transferables as the rescue if
// throughput fails, so if they do not exist, that rescue does not exist.
//
// Throwaway. Deleted when the spike resolves.
const path = require('node:path')
const { app, BrowserWindow, MessageChannelMain, ipcMain } = require('electron')

/** Same pattern the renderer generates. Prime stride catches truncation and reordering. */
function expectedByte (i) { return i % 251 }

function verify (bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, reason: `not a Uint8Array, got ${Object.prototype.toString.call(bytes)}` }
  }
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== expectedByte(i)) {
      return { ok: false, reason: `byte ${i} was ${bytes[i]}, expected ${expectedByte(i)}` }
    }
  }
  return { ok: true, reason: null, length: bytes.length }
}

function makePattern (n) {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = expectedByte(i)
  return b
}

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

  ipcMain.handle('gate0:open', () => {
    const { port1, port2 } = new MessageChannelMain()

    let streamBytes = 0
    let streamCount = 0

    port1.on('message', (event) => {
      const msg = event.data

      // A framed control message, or a raw payload chunk.
      if (msg && msg.t === 'verify') {
        port1.postMessage({ t: 'verified', id: msg.id, ...verify(msg.bytes) })
        return
      }
      if (msg && msg.t === 'stream') {
        streamBytes += msg.bytes?.length ?? 0
        streamCount += 1
        return
      }
      if (msg && msg.t === 'report') {
        port1.postMessage({ t: 'report', bytes: streamBytes, count: streamCount })
        streamBytes = 0
        streamCount = 0
        return
      }
      if (msg && msg.t === 'sendDown') {
        // Main -> renderer fidelity and throughput.
        for (let i = 0; i < msg.iterations; i++) {
          port1.postMessage({ t: 'down', bytes: makePattern(msg.size) })
        }
        port1.postMessage({ t: 'downDone', iterations: msg.iterations, size: msg.size })
        return
      }
    })
    port1.start()

    win.webContents.postMessage('gate0:port', null, [port2])
    return true
  })

  win.loadFile(path.join(__dirname, 'index.html'))
  return win
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
