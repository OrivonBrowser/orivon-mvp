// Stage A: real extensions -- load, manifest, SW namespace/call introspection,
// content scripts (top / same-origin iframe / cross-origin iframe), popup,
// defaultSession vs persist:x, getAllExtensions + extension-loaded/-ready events.
const { app, session, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { delay, serve, attachSwProbe, registerCommonPreloads } = require('./lib.js')

const OUT = process.env.PROBE_OUT || path.join(__dirname, 'result-a.json')
const EXTRACTED = process.env.PROBE_EXTRACTED
const results = { electron: process.versions.electron, chrome: process.versions.chrome, extensions: {} }
const finish = (code) => { try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) } catch {}; app.exit(code) }
app.on('window-all-closed', () => {}) // destroying a probe window between extensions must not quit the app
process.on('uncaughtException', (e) => { results.uncaught = String(e && e.stack || e); finish(1) })
process.on('unhandledRejection', (e) => { results.unhandled = String(e && e.stack || e); finish(1) })
setTimeout(() => { results.timedOut = true; finish(2) }, 118000)

const EXTS = [
  { key: 'ubol', dir: 'ubol', popup: 'popup.html' },
  { key: 'darkreader', dir: 'darkreader', popup: 'ui/popup/index.html' },
  { key: 'bitwarden', dir: 'bitwarden', popup: 'popup/index.html' },
  { key: 'metamask', dir: 'metamask', popup: 'popup-init.html' }
]

const scanScript = (label) => `(() => {
  const out = { label: ${JSON.stringify(label)}, url: location.href }
  try { out.ethereum = typeof window.ethereum } catch (e) { out.ethereum = 'err' }
  try { out.darkreaderStyles = document.querySelectorAll('style.darkreader').length } catch (e) {}
  try { out.darkreaderAttr = document.documentElement.hasAttribute('data-darkreader-mode') || document.documentElement.hasAttribute('data-darkreader-scheme') } catch (e) {}
  try { out.bitwardenCss = Array.from(document.styleSheets).some((s) => { try { return (s.href || '').includes('autofill.css') } catch (e) { return false } }) } catch (e) {}
  try { out.injectedScripts = document.querySelectorAll('script[src^="chrome-extension://"]').length } catch (e) {}
  try { out.injectedLinks = document.querySelectorAll('link[href^="chrome-extension://"]').length } catch (e) {}
  try { out.bodyTextLen = document.body ? document.body.innerText.length : 0 } catch (e) {}
  return JSON.stringify(out)
})()`

const popupScript = `(async () => {
  const out = { title: document.title, bodyLen: document.body ? document.body.innerText.length : 0 }
  try {
    out.sendMessage = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 1500)
      try {
        chrome.runtime.sendMessage({ kind: 'probe-ping' }, (resp) => {
          clearTimeout(t)
          resolve(resp === undefined ? (chrome.runtime.lastError ? 'error:' + chrome.runtime.lastError.message : 'undefined-response') : JSON.stringify(resp).slice(0, 200))
        })
      } catch (e) { clearTimeout(t); resolve('threw:' + String(e && e.message || e)) }
    })
  } catch (e) { out.sendMessage = 'outer-threw:' + String(e && e.message || e) }
  try {
    out.tabsQuery = await new Promise((resolve) => {
      try { chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(Array.isArray(tabs) ? { count: tabs.length, sample: tabs[0] ? { url: tabs[0].url, active: tabs[0].active } : null } : String(tabs))) } catch (e) { resolve('threw:' + String(e && e.message || e)) }
    })
  } catch (e) { out.tabsQuery = 'outer-threw' }
  return JSON.stringify(out)
})()`

app.whenReady().then(async () => {
  try {
    results.hasNewLoadExtensionApi = typeof session.defaultSession.extensions?.loadExtension === 'function'
    results.hasOldLoadExtensionApi = typeof session.defaultSession.loadExtension === 'function'

    const { port: p1 } = await serve({
      '/top': { body: (req, u) => `<!doctype html><html><body><h1>top</h1><iframe id="same" src="/frame"></iframe><iframe id="cross" src="http://127.0.0.1:${results.p2}/frame"></iframe></body></html>` },
      '/frame': { body: '<!doctype html><html><body><div id="mark">frame</div></body></html>' }
    })
    const { port: p2 } = await serve({ '/frame': { body: '<!doctype html><html><body><div id="mark">cross-frame</div></body></html>' } })
    results.p2 = p2
    results.ports = { p1, p2 }

    for (const spec of EXTS) {
      const r = { manifest: null, load: null }
      results.extensions[spec.key] = r
      const ses = session.fromPartition('persist:ext-' + spec.key)
      registerCommonPreloads(ses, __dirname)
      const swProbe = attachSwProbe(ses)
      // Only one extension is ever loaded into this fresh, dedicated session,
      // so any event on it is unambiguously about this extension.
      const events = { loaded: false, ready: false }
      ses.extensions.on('extension-loaded', () => { events.loaded = true })
      ses.extensions.on('extension-ready', () => { events.ready = true })
      const warnings = []
      const dir = path.join(EXTRACTED, spec.dir)
      try {
        r.manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
        const ext = await ses.extensions.loadExtension(dir, { allowFileAccess: true })
        r.id = ext.id
        r.load = 'ok'
      } catch (e) {
        r.load = 'threw: ' + String(e && e.message || e)
        continue
      }
      await delay(2500)
      r.events = events
      r.allExtensions = ses.extensions.getAllExtensions().map((x) => ({ id: x.id, name: x.name, version: x.version }))
      r.swConsole = swProbe.consoleMsgs.slice(0, 20)
      const scope = `chrome-extension://${r.id}/`
      r.sw = swProbe.byScope[scope] || swProbe.byScope[Object.keys(swProbe.byScope).find((k) => k.includes(r.id))] || null

      // Content scripts: top frame + same-origin iframe + cross-origin iframe.
      const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
      const consoleMsgs = []
      win.webContents.on('console-message', (e) => { consoleMsgs.push(`${e.level}: ${String(e.message).slice(0, 200)}`) })
      try {
        await win.loadURL(`http://127.0.0.1:${p1}/top`)
        await delay(2000)
        const frames = win.webContents.mainFrame.framesInSubtree
        const scans = {}
        for (const f of frames) {
          let label = 'unknown'
          if (f === win.webContents.mainFrame) label = 'top'
          else if (f.url.includes(`127.0.0.1:${p1}`)) label = 'same-origin-iframe'
          else if (f.url.includes(`127.0.0.1:${p2}`)) label = 'cross-origin-iframe'
          try { scans[label] = JSON.parse(await f.executeJavaScript(scanScript(label))) } catch (e) { scans[label] = 'threw: ' + String(e && e.message || e) }
        }
        r.contentScripts = scans
      } catch (e) { r.contentScripts = 'threw: ' + String(e && e.message || e) }
      r.pageConsole = consoleMsgs.slice(0, 20)
      win.destroy()

      // Popup.
      const popupWin = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
      const popupConsole = []
      popupWin.webContents.on('console-message', (e) => { popupConsole.push(`${e.level}: ${String(e.message).slice(0, 200)}`) })
      try {
        await popupWin.loadURL(`chrome-extension://${r.id}/${spec.popup}`)
        await delay(1500)
        r.popup = JSON.parse(await popupWin.webContents.executeJavaScript(popupScript))
        r.popup.framePolyfill = await popupWin.webContents.executeJavaScript('window.__orivonFramePolyfill || window.__orivonFramePolyfillError || null')
      } catch (e) { r.popup = 'threw: ' + String(e && e.message || e) }
      r.popupConsole = popupConsole.slice(0, 20)
      popupWin.destroy()
    }

    // defaultSession vs persist:x, using darkreader (lightest, best-behaved) loaded into defaultSession too.
    try {
      const before = session.defaultSession.extensions.getAllExtensions().length
      const ext = await session.defaultSession.extensions.loadExtension(path.join(EXTRACTED, 'darkreader'), { allowFileAccess: true })
      const after = session.defaultSession.extensions.getAllExtensions().length
      results.defaultSessionLoad = { ok: true, id: ext.id, before, after }
      // Same extension id should NOT show up as loaded in one of the persist:ext-* sessions (per-session loading).
      const otherSes = session.fromPartition('persist:ext-darkreader')
      results.defaultSessionLoad.visibleInOtherSession = otherSes.extensions.getAllExtensions().some((x) => x.id === ext.id)
    } catch (e) { results.defaultSessionLoad = 'threw: ' + String(e && e.message || e) }

    finish(0)
  } catch (e) {
    results.error = String(e && e.stack)
    finish(1)
  }
})
