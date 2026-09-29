// Throwaway probe: do an extension's declarativeNetRequest / webRequest rules override headers
// that the embedder adds with session.webRequest or serves through protocol.handle?
const { app, session, BrowserWindow, protocol } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const OUT = process.env.PROBE_OUT || path.join(__dirname, 'result.json')
const PAGE = `<!doctype html><html><head><title>p</title><script src="/blocked.js"></script></head><body><script>
fetch('/x').then(() => { document.documentElement.dataset.fetch = 'ok' }).catch(() => { document.documentElement.dataset.fetch = 'blocked' })
</script></body></html>`
const BLOCKED = "document.documentElement.dataset.blockedRan = 'yes'"
const CSP = "connect-src 'none'"
const results = { electron: process.versions.electron, chrome: process.versions.chrome, cases: {} }
const listenerCalls = {}


app.on('window-all-closed', () => {})
const finish = (code) => { try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) } catch {} ; app.exit(code) }
setTimeout(() => { results.timedOut = true; finish(2) }, 60000)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const serve = (pathname) => pathname === '/blocked.js'
  ? { body: BLOCKED, type: 'text/javascript' }
  : pathname === '/x' ? { body: 'x', type: 'text/plain' } : { body: PAGE, type: 'text/html' }

async function runCase (name, opts) {
  let { ext, mode, url } = opts
  const ses = session.fromPartition('persist:' + name)
  listenerCalls[name] = 0
  if (mode === 'webRequest') {
    // Orivon's T22 shape: the embedder adds a CSP on every main-frame response.
    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => {
      if (d.resourceType === 'mainFrame') {
        listenerCalls[name]++
        cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': [CSP] } })
      } else cb({})
    })
  }
  if (mode === 'webRequest-filtered') {
    // The verifier's shape: onBeforeSendHeaders on the default session, filtered to .eth hosts.
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.eth/*'] }, (d, cb) => { listenerCalls[name]++; cb({}) })
  }
  if (mode === 'protocol-late' && ext) {
    try { await ses.extensions.loadExtension(path.join(__dirname, ext)) } catch (e) { results.cases[name] = 'load threw: ' + e.message; return }
    ext = null
    mode = 'protocol'
    results['lateLoaded_' + name] = true
  } else if (mode === 'protocol-late') mode = 'protocol'
  if (mode === 'protocol') {
    // Orivon's app-partition shape: https served by protocol.handle with the CSP in the response.
    ses.protocol.handle('https', (req) => {
      listenerCalls[name]++
      const u = new URL(req.url)
      const r = serve(u.pathname)
      const headers = { 'content-type': r.type }
      if (r.type === 'text/html') headers['content-security-policy'] = CSP
      return new Response(r.body, { headers })
    })
  }
  let loaded = null
  if (ext) {
    try { loaded = await ses.extensions.loadExtension(path.join(__dirname, ext)); } catch (e) { results.cases[name] = 'load threw: ' + e.message; return }
    await delay(500)
  }
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
  try {
    await win.loadURL(url)
    await delay(1500)
    const ds = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify({ ...document.documentElement.dataset })'))
    results.cases[name] = { ext, mode, url, extLoaded: !!loaded, embedderCalls: listenerCalls[name], fetch: ds.fetch ?? null, blockedRan: ds.blockedRan ?? 'no', csRan: ds.csRan ?? 'no' }
  } catch (e) {
    results.cases[name] = { ext, mode, url, extLoaded: !!loaded, embedderCalls: listenerCalls[name], loadError: String(e.message).slice(0, 80) }
  }
  win.destroy()
}

app.whenReady().then(async () => {
  try {
    const server = http.createServer((req, res) => {
      const r = serve(new URL(req.url, 'http://x').pathname)
      res.setHeader('content-type', r.type)
      if (r.type === 'text/html' && req.url.includes('csp')) res.setHeader('Content-Security-Policy', CSP)
      res.end(r.body)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}/`
    for (const [n, e] of [['wrf-control', null], ['wrf-mv2', 'ext-wr2']]) await runCase(n, { ext: e, mode: 'webRequest-filtered', url: base + '?csp' })
    // The two runs recorded in extension-network-probe.json: this line ends run 2; delete it for run 1.
    finish(0); return
    for (const [n, e] of [['plain-control', null], ['plain-dnr', 'ext-dnr'], ['plain-mv2', 'ext-wr2']]) await runCase(n, { ext: e, mode: 'none', url: base + '?csp' })
    for (const [n, e] of [['wr-control', null], ['wr-dnr', 'ext-dnr'], ['wr-mv2', 'ext-wr2'], ['wr-cs', 'ext-cs']]) await runCase(n, { ext: e, mode: 'webRequest', url: base })
    for (const [n, e] of [['ph-control', null], ['ph-cs', 'ext-cs'], ['ph-dnr', 'ext-dnr'], ['ph-mv2', 'ext-wr2']]) await runCase(n, { ext: e, mode: 'protocol', url: 'https://app.test/' })
    for (const [n, e] of [['phl-control', null], ['phl-cs', 'ext-cs']]) await runCase(n, { ext: e, mode: 'protocol-late', url: 'https://app.test/' })
    finish(0)
  } catch (e) { results.error = String(e && e.stack); finish(1) }
})
