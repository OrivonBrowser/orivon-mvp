// GATE 1b -- preload. TCP bridge (from gate 1a) plus a UDP bridge.
//
// Raw MessagePorts stay in the isolated world (security-model.md T17); the
// page gets closures only.
const { contextBridge, ipcRenderer } = require('electron')

// ---- TCP -------------------------------------------------------------------
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

// ---- UDP -------------------------------------------------------------------
let nextUdpId = 1
const udpSockets = new Map()

ipcRenderer.on('dgram:port', (event, { id }) => {
  const entry = udpSockets.get(id)
  if (!entry) return
  const port = event.ports[0]
  entry.port = port
  port.onmessage = (e) => {
    const m = e.data
    if (m.t === 'message') entry.cbs.onMessage(m.b, m.rinfo)
    else if (m.t === 'listening') entry.cbs.onListening(m.addr)
    else if (m.t === 'error') entry.cbs.onError(m.m)
    else if (m.t === 'close') entry.cbs.onClose()
  }
  port.start()
  // Same buffering rule as TCP: a bind() issued before the port arrived is
  // queued here and flushed, so the shim can present Node's synchronous shape.
  for (const queued of entry.queue) port.postMessage(queued)
  entry.queue.length = 0
})

contextBridge.exposeInMainWorld('__spikeDgram', {
  create (type, cbs) {
    const id = nextUdpId++
    const entry = { port: null, queue: [], cbs }
    udpSockets.set(id, entry)
    void ipcRenderer.invoke('dgram:create', { id, type })
    const send = (msg) => {
      if (entry.port !== null) entry.port.postMessage(msg)
      else entry.queue.push(msg)
    }
    return {
      bind: (port, address) => send({ t: 'bind', port, address }),
      send: (bytes, port, address) => send({ t: 'send', b: bytes, port, address }),
      close: () => { send({ t: 'close' }); udpSockets.delete(id) }
    }
  }
})
