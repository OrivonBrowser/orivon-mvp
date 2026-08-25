// GATE 3 -- preload. TCP bridge only.
//
// Raw MessagePorts stay in the isolated world (security-model.md T17); the
// page gets closures only.
const { contextBridge, ipcRenderer } = require('electron')

let nextNetId = 1
const netSockets = new Map()

ipcRenderer.on('net:port', (event, { id }) => {
  const entry = netSockets.get(id)
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
  for (const queued of entry.queue) port.postMessage(queued)
  entry.queue.length = 0
})

contextBridge.exposeInMainWorld('__spikeNet', {
  connect (host, port, cbs) {
    const id = nextNetId++
    const entry = { port: null, queue: [], cbs }
    netSockets.set(id, entry)
    void ipcRenderer.invoke('net:connect', { id, host, port })
    const send = (msg) => {
      if (entry.port !== null) entry.port.postMessage(msg)
      else entry.queue.push(msg)
    }
    return {
      write: (bytes) => send({ t: 'write', b: bytes }),
      end: () => send({ t: 'end' }),
      destroy: () => { send({ t: 'destroy' }); netSockets.delete(id) }
    }
  }
})

// Exposes whether a service worker registered, and gives the page access to
// probe it -- kept minimal on purpose since gate 3's decision (SW vs custom
// scheme) is made empirically, not assumed.
contextBridge.exposeInMainWorld('__gate3Env', {
  isSecureContext: () => globalThis.isSecureContext
})
