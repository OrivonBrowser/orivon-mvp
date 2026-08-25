// GATE 0 -- preload side.
//
// The raw port stays HERE, in the isolated world. The page gets closures only.
// This is capability-api.md SS Throughput's security rule, not an optimisation
// detail: transferring the port into the page would hand a raw socket to
// anything the page can reach (security-model.md T17). The spike measures
// through this wrapper deliberately -- measuring the raw port would measure a
// path the product cannot ship.
const { contextBridge, ipcRenderer } = require('electron')

let port = null
let nextId = 1
const pendingVerify = new Map()
let reportResolver = null
let downResolver = null
let downState = null

ipcRenderer.on('gate0:port', (event) => {
  port = event.ports[0]

  port.onmessage = (e) => {
    const msg = e.data

    if (msg?.t === 'verified') {
      pendingVerify.get(msg.id)?.({ ok: msg.ok, reason: msg.reason, length: msg.length })
      pendingVerify.delete(msg.id)
      return
    }
    if (msg?.t === 'report') {
      reportResolver?.({ bytes: msg.bytes, count: msg.count })
      reportResolver = null
      return
    }
    if (msg?.t === 'down') {
      if (downState !== null) {
        downState.count += 1
        downState.bytes += msg.bytes?.length ?? 0
        if (downState.firstBad === null) {
          const bytes = msg.bytes
          if (!(bytes instanceof Uint8Array)) {
            downState.firstBad = 'not a Uint8Array'
          } else {
            for (let i = 0; i < bytes.length; i++) {
              if (bytes[i] !== i % 251) { downState.firstBad = `byte ${i} was ${bytes[i]}`; break }
            }
          }
        }
      }
      return
    }
    if (msg?.t === 'downDone') {
      downResolver?.({ ...downState, expectedBytes: msg.iterations * msg.size })
      downResolver = null
      downState = null
      return
    }
  }
  port.start()
})

function pattern (n) {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = i % 251
  return b
}

contextBridge.exposeInMainWorld('__gate0', {
  open: () => ipcRenderer.invoke('gate0:open'),

  ready: () => port !== null,

  /** Renderer -> main, structured clone (no transfer list). Main verifies. */
  verifyUp: (size) => new Promise((resolve) => {
    const id = nextId++
    pendingVerify.set(id, resolve)
    port.postMessage({ t: 'verify', id, bytes: pattern(size) })
  }),

  /**
   * Renderer -> main WITH a transfer list. electron#34905.
   *
   * Needs a timeout: the observed failure mode is not an exception and not
   * corruption. postMessage returns normally and the message NEVER ARRIVES,
   * so an un-timed promise hangs forever. "Silently dropped" is itself the
   * result worth recording.
   */
  transferUp: (size, timeoutMs = 2000) => new Promise((resolve) => {
    const id = nextId++
    const bytes = pattern(size)

    const timer = setTimeout(() => {
      pendingVerify.delete(id)
      resolve({
        ok: false,
        outcome: 'dropped',
        reason: `no reply within ${timeoutMs}ms - message never arrived in main`
      })
    }, timeoutMs)

    pendingVerify.set(id, (r) => { clearTimeout(timer); resolve({ ...r, outcome: 'delivered' }) })

    try {
      port.postMessage({ t: 'verify', id, bytes }, [bytes.buffer])
    } catch (err) {
      clearTimeout(timer)
      pendingVerify.delete(id)
      resolve({ ok: false, outcome: 'threw', reason: String(err) })
    }
  }),

  /** Fire N chunks upward without awaiting, then ask main what it received. */
  streamUp: async (size, iterations) => {
    const bytes = pattern(size)
    const started = performance.now()
    for (let i = 0; i < iterations; i++) port.postMessage({ t: 'stream', bytes })
    const report = await new Promise((resolve) => {
      reportResolver = resolve
      port.postMessage({ t: 'report' })
    })
    return { ...report, ms: performance.now() - started, expectedBytes: size * iterations }
  },

  /** Ask main to fire N chunks downward; verify and time them. */
  streamDown: async (size, iterations) => {
    downState = { count: 0, bytes: 0, firstBad: null }
    const started = performance.now()
    const result = await new Promise((resolve) => {
      downResolver = resolve
      port.postMessage({ t: 'sendDown', size, iterations })
    })
    return { ...result, ms: performance.now() - started }
  }
})
