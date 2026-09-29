const http = require('node:http')
const path = require('node:path')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// Serves a fixed route table: { '/path': { type, body } }. Returns { server, port }.
function serve (routes, extraHandler) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (extraHandler && extraHandler(req, res, u)) return
    const r = routes[u.pathname]
    if (!r) { res.statusCode = 404; res.end('not found'); return }
    res.setHeader('content-type', r.type || 'text/html')
    if (r.headers) for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v)
    res.end(typeof r.body === 'function' ? r.body(req, u) : r.body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// Attach the sw-probe-preload's session-wide reporting: collects every
// `probe:sw` message keyed by scope (extension id or website SW URL).
function attachSwProbe (ses) {
  const byScope = {}
  const attached = new Set()
  const tryAttach = (versionId) => {
    if (attached.has(versionId)) return
    try {
      const w = ses.serviceWorkers.getWorkerFromVersionID(versionId)
      if (!w) return
      attached.add(versionId)
      w.ipc.on('probe:sw', (event, payload) => {
        const key = w.scope
        byScope[key] = byScope[key] || { scope: w.scope, scriptURL: w.scriptURL, messages: [] }
        byScope[key].messages.push(payload)
      })
    } catch (e) {}
  }
  ses.serviceWorkers.on('running-status-changed', (e) => tryAttach(e.versionId))
  const consoleMsgs = []
  ses.serviceWorkers.on('console-message', (e, details) => { consoleMsgs.push({ versionId: details.versionId, level: details.level, message: String(details.message).slice(0, 300) }) })
  return { byScope, consoleMsgs }
}

function registerCommonPreloads (ses, dir) {
  ses.registerPreloadScript({ type: 'service-worker', filePath: path.join(dir, 'sw-probe-preload.js') })
  ses.registerPreloadScript({ type: 'frame', filePath: path.join(dir, 'frame-probe-preload.js') })
}

// SW introspection only, no frame preload -- used in stage F so any main-world
// crash (e.g. LavaMoat scuttling) can only be attributed to
// electron-chrome-extensions' own preloads, never to our custom one.
function registerSwProbeOnly (ses, dir) {
  ses.registerPreloadScript({ type: 'service-worker', filePath: path.join(dir, 'sw-probe-preload.js') })
}

module.exports = { delay, serve, attachSwProbe, registerCommonPreloads, registerSwProbeOnly }
