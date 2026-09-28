// Stage E: isolate whether MetaMask's popup failure in stage A was caused by
// the frame-probe-preload's window.__orivonFramePolyfill write (LavaMoat
// scuttling trips on any unexpected globalThis property), by loading the
// popup in a session with NO frame preload registered at all.
const { app, session, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { delay } = require('./lib.js')

const OUT = process.env.PROBE_OUT || path.join(__dirname, 'result-e.json')
const EXTRACTED = process.env.PROBE_EXTRACTED
const results = { electron: process.versions.electron, chrome: process.versions.chrome }
const finish = (code) => { try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) } catch {}; app.exit(code) }
app.on('window-all-closed', () => {})
process.on('uncaughtException', (e) => { results.uncaught = String(e && e.stack || e); finish(1) })
process.on('unhandledRejection', (e) => { results.unhandled = String(e && e.stack || e); finish(1) })
setTimeout(() => { results.timedOut = true; finish(2) }, 118000)

app.whenReady().then(async () => {
  try {
    const ses = session.fromPartition('persist:metamask-nopoly')
    // Deliberately no registerPreloadScript calls at all.
    const ext = await ses.extensions.loadExtension(path.join(EXTRACTED, 'metamask'), { allowFileAccess: true })
    results.extId = ext.id
    await delay(2500)
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
    const consoleMsgs = []
    win.webContents.on('console-message', (e) => { consoleMsgs.push(`${e.level}: ${String(e.message).slice(0, 250)}`) })
    try {
      await win.loadURL(`chrome-extension://${ext.id}/popup-init.html`)
      await delay(2000)
      results.popup = JSON.parse(await win.webContents.executeJavaScript(
        `JSON.stringify({ title: document.title, bodyLen: document.body ? document.body.innerText.length : 0 })`
      ))
    } catch (e) { results.popup = 'threw: ' + String(e && e.message || e) }
    results.popupConsole = consoleMsgs.slice(0, 20)
    win.destroy()
    finish(0)
  } catch (e) {
    results.error = String(e && e.stack)
    finish(1)
  }
})
