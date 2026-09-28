// Stage C: MV3 chrome.webRequest (observation, and blocking declared via the
// non-standard "webRequestBlocking" permission), with and without an
// embedder session.webRequest listener.
const { app, session, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { delay, serve, registerCommonPreloads, attachSwProbe } = require('./lib.js')

const OUT = process.env.PROBE_OUT || path.join(__dirname, 'result-c.json')
const results = { electron: process.versions.electron, chrome: process.versions.chrome, cases: {} }
const finish = (code) => { try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) } catch {}; app.exit(code) }
app.on('window-all-closed', () => {})
process.on('uncaughtException', (e) => { results.uncaught = String(e && e.stack || e); finish(1) })
process.on('unhandledRejection', (e) => { results.unhandled = String(e && e.stack || e); finish(1) })
setTimeout(() => { results.timedOut = true; finish(2) }, 118000)

const JS = { type: 'text/javascript', body: 'void 0' }

async function runCase (name, { withExt, withEmbedderListener }) {
  const ses = session.fromPartition('persist:wr-' + name)
  registerCommonPreloads(ses, __dirname)
  const swProbe = attachSwProbe(ses)
  let embedderCalls = 0
  if (withEmbedderListener) {
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.eth/*'] }, (d, cb) => { embedderCalls++; cb({}) })
  }
  const { port } = await serve({
    '/probe-block/wrblock.js': JS,
    '/probe-block/wrobserve.js': JS,
    '/probe-block/control.js': JS,
    '/page': {
      body: `<!doctype html><html><body><script>window.__loaded = {}</script>
        <script src="/probe-block/wrblock.js" onload="__loaded.wrblock='loaded'" onerror="__loaded.wrblock='blocked'"></script>
        <script src="/probe-block/wrobserve.js" onload="__loaded.wrobserve='loaded'" onerror="__loaded.wrobserve='blocked'"></script>
        <script src="/probe-block/control.js" onload="__loaded.control='loaded'" onerror="__loaded.control='blocked'"></script>
        </body></html>`
    }
  })
  const r = { extLoaded: false }
  if (withExt) {
    try {
      const ext = await ses.extensions.loadExtension(path.join(__dirname, 'ext-webrequest'), { allowFileAccess: true })
      r.extId = ext.id
      r.extLoaded = true
    } catch (e) { r.extLoadErr = String(e && e.message || e) }
    await delay(1000)
  }
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
  const consoleMsgs = []
  win.webContents.on('console-message', (e) => { consoleMsgs.push(`${e.level}: ${String(e.message).slice(0, 200)}`) })
  try {
    await win.loadURL(`http://127.0.0.1:${port}/page`)
    await delay(1800)
    r.loaded = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__loaded || {})'))
    r.wrStatus = JSON.parse(await win.webContents.executeJavaScript(
      "document.documentElement.dataset.wrStatus || document.documentElement.dataset.wrStatusErr || 'null'"
    ).catch(() => '"n/a"'))
  } catch (e) { r.pageErr = String(e && e.message || e) }
  r.embedderCalls = embedderCalls
  r.console = consoleMsgs.slice(0, 15)
  r.sw = swProbe.byScope
  r.swConsole = swProbe.consoleMsgs.slice(0, 15)
  win.destroy()
  results.cases[name] = r
}

app.whenReady().then(async () => {
  try {
    await runCase('control-no-ext', { withExt: false, withEmbedderListener: false })
    await runCase('plain', { withExt: true, withEmbedderListener: false })
    await runCase('withwr', { withExt: true, withEmbedderListener: true })
    finish(0)
  } catch (e) {
    results.error = String(e && e.stack)
    finish(1)
  }
})
