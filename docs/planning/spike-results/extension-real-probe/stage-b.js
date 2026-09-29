// Stage B: declarativeNetRequest matrix (static / dynamic / session rules,
// each with and without an embedder session.webRequest listener) using tiny
// custom extensions, plus uBOL's real default rulesets against a known
// easylist path rule with no domain anchor.
const { app, session, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { delay, serve, registerCommonPreloads, attachSwProbe } = require('./lib.js')

const OUT = process.env.PROBE_OUT || path.join(__dirname, 'result-b.json')
const EXTRACTED = process.env.PROBE_EXTRACTED
const results = { electron: process.versions.electron, chrome: process.versions.chrome, cases: {} }
const finish = (code) => { try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) } catch {}; app.exit(code) }
app.on('window-all-closed', () => {})
process.on('uncaughtException', (e) => { results.uncaught = String(e && e.stack || e); finish(1) })
process.on('unhandledRejection', (e) => { results.unhandled = String(e && e.stack || e); finish(1) })
setTimeout(() => { results.timedOut = true; finish(2) }, 118000)

const JS = { type: 'text/javascript', body: 'void 0' }

async function runCase (name, { extDir, withEmbedderListener, extra }) {
  const ses = session.fromPartition('persist:dnr-' + name)
  registerCommonPreloads(ses, __dirname)
  const swProbe = attachSwProbe(ses)
  let embedderCalls = 0
  if (withEmbedderListener) {
    // Same shape the exploration doc's network probe used: filtered to a
    // path that matches nothing on this test page, to isolate "any listener
    // exists" from "the listener actually touches this request".
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.eth/*'] }, (d, cb) => { embedderCalls++; cb({}) })
  }
  const { port } = await serve({
    '/probe-block/static.js': JS,
    '/probe-block/dynamic.js': JS,
    '/probe-block/session.js': JS,
    '/probe-block/control.js': JS,
    '/xpopup/xpopup.js': JS,
    '/page': {
      body: `<!doctype html><html><body><script>window.__loaded = {}</script>
        <script src="/probe-block/static.js" onload="__loaded.static='loaded'" onerror="__loaded.static='blocked'"></script>
        <script src="/probe-block/dynamic.js" onload="__loaded.dynamic='loaded'" onerror="__loaded.dynamic='blocked'"></script>
        <script src="/probe-block/session.js" onload="__loaded.session='loaded'" onerror="__loaded.session='blocked'"></script>
        <script src="/probe-block/control.js" onload="__loaded.control='loaded'" onerror="__loaded.control='blocked'"></script>
        <script src="/xpopup/xpopup.js" onload="__loaded.xpopup='loaded'" onerror="__loaded.xpopup='blocked'"></script>
        </body></html>`
    }
  })
  const r = { extLoaded: false, embedderCalls: 0 }
  if (extDir) {
    try {
      const ext = await ses.extensions.loadExtension(path.join(EXTRACTED_OR_LOCAL(extDir), extDir), { allowFileAccess: true })
      r.extId = ext.id
      r.extLoaded = true
    } catch (e) { r.extLoadErr = String(e && e.message || e) }
    await delay(1500)
  }
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: false, sandbox: true } })
  const consoleMsgs = []
  win.webContents.on('console-message', (e) => { consoleMsgs.push(`${e.level}: ${String(e.message).slice(0, 200)}`) })
  try {
    await win.loadURL(`http://127.0.0.1:${port}/page`)
    await delay(1800)
    r.loaded = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__loaded || {})'))
    if (extra) r.dnrStatus = JSON.parse(await win.webContents.executeJavaScript(`document.documentElement.dataset.dnrStatus || document.documentElement.dataset.dnrStatusErr || 'no-cs-report'`).catch(() => 'n/a'))
  } catch (e) { r.pageErr = String(e && e.message || e) }
  r.embedderCalls = embedderCalls
  r.console = consoleMsgs.slice(0, 15)
  r.sw = swProbe.byScope
  r.swConsole = swProbe.consoleMsgs.slice(0, 15)
  win.destroy()
  results.cases[name] = r
}

function EXTRACTED_OR_LOCAL (extDir) {
  // Custom probe extensions live alongside this script; the real one (uBOL) lives in EXTRACTED.
  return extDir === 'ubol' ? EXTRACTED : __dirname
}

app.whenReady().then(async () => {
  try {
    await runCase('static-plain', { extDir: 'ext-dnr-static', withEmbedderListener: false })
    await runCase('static-withwr', { extDir: 'ext-dnr-static', withEmbedderListener: true })
    await runCase('dynamic-plain', { extDir: 'ext-dnr-dynamic', withEmbedderListener: false, extra: true })
    await runCase('dynamic-withwr', { extDir: 'ext-dnr-dynamic', withEmbedderListener: true, extra: true })
    await runCase('control-no-ext', { extDir: null, withEmbedderListener: false })
    await runCase('ubol-plain', { extDir: 'ubol', withEmbedderListener: false })
    await runCase('ubol-withwr', { extDir: 'ubol', withEmbedderListener: true })
    finish(0)
  } catch (e) {
    results.error = String(e && e.stack)
    finish(1)
  }
})
