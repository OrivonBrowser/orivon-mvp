// Throwaway probe: what can a Chrome extension's scripts see of a contextBridge-exposed
// global in Electron 44, and where do its content scripts run?
const { app, session, BrowserWindow, protocol } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const OUT = process.env.PROBE_OUT || path.join(__dirname, 'result.json')
const PAGE = '<!doctype html><html><head><title>p</title></head><body>page</body></html>'
const results = { electron: process.versions.electron, chrome: process.versions.chrome, pages: {} }
const warnings = []

protocol.registerSchemesAsPrivileged([
  { scheme: 'probe3', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const finish = (code) => {
  try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) } catch {}
  app.exit(code)
}
setTimeout(() => { results.timedOut = true; finish(2) }, 60000)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const dataset = (wc) => wc.executeJavaScript('JSON.stringify({ ...document.documentElement.dataset })').then(JSON.parse)
const pageSide = (wc) => wc.executeJavaScript(`(() => {
  const d = Object.getOwnPropertyDescriptor(window, 'orivon')
  return JSON.stringify({
    typeofOrivon: typeof window.orivon,
    desc: d ? { writable: d.writable, configurable: d.configurable, enumerable: d.enumerable } : null,
    frozen: window.orivon ? Object.isFrozen(window.orivon) : null,
  })
})()`).then(JSON.parse)

app.whenReady().then(async () => {
  try {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      if (req.url.startsWith('/csp')) res.setHeader('Content-Security-Policy', "script-src 'self'")
      res.end(PAGE)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port

    const ses = session.fromPartition('persist:probe')
    ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'preload-session.js') })
    try {
      ses.registerPreloadScript({ type: 'service-worker', filePath: path.join(__dirname, 'sw-preload.js') })
      results.swPreloadRegistered = true
    } catch (e) { results.swPreloadRegistered = String(e.message) }
    ses.protocol.handle('probe3', () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }))

    const ext = await ses.extensions.loadExtension(path.join(__dirname, 'ext-mv3'))
    results.mv3Id = ext.id
    try {
      const mv2 = await ses.extensions.loadExtension(path.join(__dirname, 'ext-mv2'))
      results.mv2Loaded = { id: mv2.id }
    } catch (e) { results.mv2Loaded = 'threw: ' + e.message }
    try {
      const k = await ses.extensions.loadExtension(path.join(__dirname, 'ext-keys'))
      results.unknownKeys = { loaded: true, manifestOrivon: k.manifest.orivon ?? null, permissions: k.manifest.permissions }
    } catch (e) { results.unknownKeys = 'threw: ' + e.message }
    try {
      await session.fromPartition('probe-mem').extensions.loadExtension(path.join(__dirname, 'ext-mv3'))
      results.inMemorySession = 'loaded'
    } catch (e) { results.inMemorySession = 'threw: ' + e.message }

    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: ses, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload-wp.js') },
    })
    win.webContents.on('console-message', (e) => { warnings.push(`${e.level}: ${e.message}`.slice(0, 300)) })

    const urls = [
      `http://127.0.0.1:${port}/`,
      `http://127.0.0.1:${port}/?mutate`,
      `http://127.0.0.1:${port}/csp`,
      `http://probe.eth:${port}/`,
      'probe3://site/',
    ]
    for (const url of urls) {
      try {
        await win.loadURL(url)
        await delay(1500)
        results.pages[url] = { dataset: await dataset(win.webContents), page: await pageSide(win.webContents) }
      } catch (e) { results.pages[url] = 'threw: ' + e.message }
    }

    // The extension's own page: does a session-level or webPreferences preload reach it?
    try {
      await win.loadURL(`chrome-extension://${ext.id}/page.html`)
      await delay(500)
      results.extensionPage = JSON.parse(await win.webContents.executeJavaScript(
        'JSON.stringify({ orivon: typeof window.orivon, orivonWp: typeof window.orivonWp, chromeRuntime: typeof chrome?.runtime?.id })'))
    } catch (e) { results.extensionPage = 'threw: ' + e.message }

    // A second persistent session without the extension loaded.
    const ses2 = session.fromPartition('persist:probe-other')
    ses2.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'preload-session.js') })
    const win2 = new BrowserWindow({ show: false, webPreferences: { session: ses2, contextIsolation: true, sandbox: true } })
    await win2.loadURL(`http://127.0.0.1:${port}/`)
    await delay(1000)
    results.otherSession = await dataset(win2.webContents)

    results.consoleWarnings = warnings.filter((w) => !w.startsWith('0:')).slice(0, 20)
    finish(0)
  } catch (e) {
    results.error = String(e && e.stack)
    finish(1)
  }
})
