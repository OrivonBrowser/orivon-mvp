// Stage F: rerun the four real extensions WITH electron-chrome-extensions
// (npm 4.9.0 -- yarn install against a fresh clone of upstream HEAD
// (354b0b8) was blocked by this session's sandbox; the coordinator's
// fallback ("npm install electron-chrome-extensions@4.9.0 into the scratch
// probe dir, note which") was used instead. The published 4.9.0 dist
// already contains the tabs.getCurrent handler that HEAD's tabs.ts carries
// (confirmed by grepping dist/cjs/index.js), so it is functionally close to
// HEAD for everything this stage measures.)
//
// Our own sw-probe-preload (patch+introspect) stays registered so results
// are comparable with stage A. Our own FRAME preload is deliberately left
// unregistered here: the library registers its own frame preload
// (contextBridge.exposeInMainWorld('electron', ...)), and the question is
// whether THAT one trips LavaMoat in MetaMask's popup -- conflating it with
// our own __orivonFramePolyfill write (stage A/E already answered that one)
// would make the result ambiguous.
const { app, session, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT = process.env.PROBE_OUT || path.join(__dirname, 'result-f.json')
const EXTRACTED = process.env.PROBE_EXTRACTED
const results = { electron: process.versions.electron, chrome: process.versions.chrome, library: 'electron-chrome-extensions', extensions: {} }
const finish = (code) => { try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) } catch {}; app.exit(code) }
app.on('window-all-closed', () => {})
process.on('uncaughtException', (e) => { results.uncaught = String(e && e.stack || e); finish(1) })
process.on('unhandledRejection', (e) => { results.unhandled = String(e && e.stack || e); finish(1) })
setTimeout(() => { results.timedOut = true; finish(2) }, 118000)

// Requires that can throw (module resolution, package.json subpath quirks)
// happen only after the handlers above exist, so a failure here still gets
// written to OUT instead of hitting Electron's fatal-error dialog path.
let delay, serve, attachSwProbe, registerSwProbeOnly, ElectronChromeExtensions
try {
  ;({ delay, serve, attachSwProbe, registerSwProbeOnly } = require('./lib.js'))
  ;({ ElectronChromeExtensions } = require('electron-chrome-extensions'))
  results.libraryVersionInstalled = JSON.parse(fs.readFileSync(path.join(__dirname, 'node_modules/electron-chrome-extensions/package.json'), 'utf8')).version
  results.note = 'npm-installed 4.9.0, not a from-source build of upstream HEAD 354b0b8 (yarn install was denied by the sandbox); dist/cjs/index.js was grepped and confirmed to already register tabs.getCurrent'
} catch (e) {
  results.setupError = String(e && e.stack || e)
  finish(1)
  return
}

const EXTS = [
  { key: 'ubol', dir: 'ubol', popup: 'popup.html' },
  { key: 'darkreader', dir: 'darkreader', popup: 'ui/popup/index.html' },
  { key: 'bitwarden', dir: 'bitwarden', popup: 'popup/index.html' },
  { key: 'metamask', dir: 'metamask', popup: 'popup-init.html' }
]

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
  try {
    out.tabsGetCurrent = await new Promise((resolve) => {
      try { chrome.tabs.getCurrent((tab) => resolve(chrome.runtime.lastError ? 'error:' + chrome.runtime.lastError.message : (tab ? { id: tab.id } : 'undefined-tab'))) } catch (e) { resolve('threw:' + String(e && e.message || e)) }
    })
  } catch (e) { out.tabsGetCurrent = 'outer-threw' }
  return JSON.stringify(out)
})()`

app.whenReady().then(async () => {
  try {
    const { port } = await serve({
      '/xpopup/xpopup.js': { type: 'text/javascript', body: 'void 0' },
      '/page': {
        body: `<!doctype html><html><body><h1>stage-f tab</h1><script>window.__loaded = {}</script>
          <script src="/xpopup/xpopup.js" onload="__loaded.xpopup='loaded'" onerror="__loaded.xpopup='blocked'"></script>
          </body></html>`
      }
    })

    for (const spec of EXTS) {
      const r = {}
      results.extensions[spec.key] = r
      const ses = session.fromPartition('persist:ecx-' + spec.key)
      registerSwProbeOnly(ses, __dirname)
      const swProbe = attachSwProbe(ses)
      const statusHistory = []
      ses.serviceWorkers.on('running-status-changed', (e) => { statusHistory.push({ t: Date.now(), versionId: e.versionId, status: e.runningStatus }) })
      const libraryWarnings = []
      const origConsoleWarn = console.warn
      const origConsoleError = console.error
      const origEmitWarning = process.emitWarning
      console.warn = (...a) => { libraryWarnings.push('warn: ' + a.map(String).join(' ').slice(0, 300)); origConsoleWarn(...a) }
      console.error = (...a) => { libraryWarnings.push('error: ' + a.map(String).join(' ').slice(0, 300)); origConsoleError(...a) }
      process.emitWarning = (w, ...rest) => { libraryWarnings.push('emitWarning: ' + String(w).slice(0, 300)); return origEmitWarning(w, ...rest) }

      let extensions
      try {
        extensions = new ElectronChromeExtensions({
          license: 'GPL-3.0',
          session: ses,
          createTab: async () => { throw new Error('createTab not implemented in this probe') },
          selectTab: () => {},
          removeTab: () => {},
          createWindow: async () => { throw new Error('createWindow not implemented in this probe') },
          removeWindow: () => {}
        })
        r.constructed = true
      } catch (e) {
        r.constructed = false
        r.constructErr = String(e && e.message || e)
        console.warn = origConsoleWarn; console.error = origConsoleError; process.emitWarning = origEmitWarning
        continue
      }

      const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
      const tabConsole = []
      win.webContents.on('console-message', (e) => { tabConsole.push(`${e.level}: ${String(e.message).slice(0, 200)}`) })
      await win.loadURL(`http://127.0.0.1:${port}/page`)
      await delay(300)
      extensions.addTab(win.webContents, win)
      extensions.selectTab(win.webContents)

      const dir = path.join(EXTRACTED, spec.dir)
      try {
        const ext = await ses.extensions.loadExtension(dir, { allowFileAccess: true })
        r.id = ext.id
        r.load = 'ok'
      } catch (e) {
        r.load = 'threw: ' + String(e && e.message || e)
      }

      // "stays running for 10s": sample at +2s and again at +10s after load.
      await delay(2000)
      r.runningAt2s = r.id ? Object.keys(ses.serviceWorkers.getAllRunning()).some((vid) => {
        const info = ses.serviceWorkers.getAllRunning()[vid]
        return info && info.scope && info.scope.includes(r.id)
      }) : false
      await delay(8000)
      r.runningAt10s = r.id ? Object.keys(ses.serviceWorkers.getAllRunning()).some((vid) => {
        const info = ses.serviceWorkers.getAllRunning()[vid]
        return info && info.scope && info.scope.includes(r.id)
      }) : false

      r.statusHistory = statusHistory.filter((s) => true).slice(0, 30)
      const scope = r.id ? `chrome-extension://${r.id}/` : null
      r.sw = scope ? (swProbe.byScope[scope] || null) : null
      r.swConsoleFirst3Errors = swProbe.consoleMsgs.filter((m) => m.level >= 2).slice(0, 3)
      r.swConsoleAll = swProbe.consoleMsgs.slice(0, 20)

      try {
        r.xpopupLoaded = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__loaded || {})'))
      } catch (e) { r.xpopupLoaded = 'threw: ' + String(e && e.message || e) }
      r.tabConsole = tabConsole.slice(0, 15)
      win.destroy()

      const popupWin = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
      const popupConsole = []
      popupWin.webContents.on('console-message', (e) => { popupConsole.push(`${e.level}: ${String(e.message).slice(0, 250)}`) })
      try {
        await popupWin.loadURL(`chrome-extension://${r.id}/${spec.popup}`)
        await delay(2000)
        r.popup = JSON.parse(await popupWin.webContents.executeJavaScript(popupScript))
      } catch (e) { r.popup = 'threw: ' + String(e && e.message || e) }
      r.popupConsole = popupConsole.slice(0, 25)
      r.popupLavaMoatCrash = popupConsole.some((m) => m.includes('LavaMoat') && m.includes('scuttl'))
      popupWin.destroy()

      console.warn = origConsoleWarn; console.error = origConsoleError; process.emitWarning = origEmitWarning
      r.libraryWarnings = libraryWarnings.slice(0, 20)
    }

    finish(0)
  } catch (e) {
    results.error = String(e && e.stack)
    finish(1)
  }
})
