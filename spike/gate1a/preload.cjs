// GATE 1a -- preload. The bridge.
//
// The raw MessagePort NEVER crosses into the page (security-model.md T17).
// The page gets closures, and the shim in the renderer builds a Node-shaped
// socket on top of them. That is the layering A10 settled: web-standard
// primitives underneath, Node shapes presented by the shim.
const { contextBridge, ipcRenderer } = require('electron')

let nextId = 1
const sockets = new Map()

ipcRenderer.on('net:port', (event, { id }) => {
  const entry = sockets.get(id)
  if (!entry) return

  const port = event.ports[0]
  entry.port = port

  port.onmessage = (e) => {
    const m = e.data
    if (m.t === 'data') entry.cbs.onData(m.b)
    else if (m.t === 'connect') entry.cbs.onConnect()
    else if (m.t === 'end') entry.cbs.onEnd()
    else if (m.t === 'close') entry.cbs.onClose()
    else if (m.t === 'error') entry.cbs.onError(m.m)
  }
  port.start()

  // Design rule 2 in practice: net.connect() is synchronous in shape, the IPC
  // boundary is not, so writes issued before the port existed are queued here
  // and flushed once it arrives.
  for (const queued of entry.queue) port.postMessage(queued)
  entry.queue.length = 0
})

contextBridge.exposeInMainWorld('__spikeNet', {
  connect (host, port, cbs) {
    const id = nextId++
    const entry = { port: null, queue: [], cbs }
    sockets.set(id, entry)

    void ipcRenderer.invoke('net:connect', { id, host, port })

    const send = (msg) => {
      if (entry.port !== null) entry.port.postMessage(msg)
      else entry.queue.push(msg)
    }

    return {
      write: (bytes) => send({ t: 'write', b: bytes }),
      end: () => send({ t: 'end' }),
      destroy: () => { send({ t: 'destroy' }); sockets.delete(id) }
    }
  }
})
