// Stage D: does a session-wide 'service-worker' preload also run inside an
// ordinary website's own service worker (registered via
// navigator.serviceWorker.register), not just extension service workers?
// Also exercises the custom ext-polyfill-probe extension, whose bg.js reads
// back what the SW preload polyfilled, from inside the extension's own
// (unprivileged, LavaMoat-free) code -- a second, independent confirmation
// of stage A's "patch" results.
const { app, session, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { delay, serve, registerCommonPreloads, attachSwProbe } = require('./lib.js')

const OUT = process.env.PROBE_OUT || path.join(__dirname, 'result-d.json')
const results = { electron: process.versions.electron, chrome: process.versions.chrome }
const finish = (code) => { try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) } catch {}; app.exit(code) }
app.on('window-all-closed', () => {})
process.on('uncaughtException', (e) => { results.uncaught = String(e && e.stack || e); finish(1) })
process.on('unhandledRejection', (e) => { results.unhandled = String(e && e.stack || e); finish(1) })
setTimeout(() => { results.timedOut = true; finish(2) }, 118000)

const SW_JS = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))`

app.whenReady().then(async () => {
  try {
    const ses = session.fromPartition('persist:scope-test')
    registerCommonPreloads(ses, __dirname)
    const swProbe = attachSwProbe(ses)

    const { port } = await serve({
      '/sw.js': { type: 'text/javascript', body: SW_JS },
      '/page': {
        body: `<!doctype html><html><body><script>
          window.__swState = 'pending'
          navigator.serviceWorker.register('/sw.js').then(() => { window.__swState = 'registered' }).catch((e) => { window.__swState = 'threw:' + e })
        </script></body></html>`
      }
    })

    const ext = await ses.extensions.loadExtension(path.join(__dirname, 'ext-polyfill-probe'), { allowFileAccess: true })
    results.polyfillExtId = ext.id
    await delay(1200)

    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
    await win.loadURL(`http://127.0.0.1:${port}/page`)
    await delay(2500)
    results.pageSwState = await win.webContents.executeJavaScript('window.__swState')

    // The polyfill extension's own content script report (bg.js's own view, no LavaMoat).
    results.polyfillExtOwnReport = JSON.parse(await win.webContents.executeJavaScript(
      "document.documentElement.dataset.polyfillStatus || document.documentElement.dataset.polyfillStatusErr || 'null'"
    ).catch(() => '"n/a"'))

    win.destroy()

    // Everything the sw preload saw in this session, keyed by scope: the
    // extension's chrome-extension:// scope AND (if item 5 is true) the
    // website's own http://127.0.0.1:<port>/ scope for /sw.js.
    results.swScopes = Object.keys(swProbe.byScope)
    results.swByScope = swProbe.byScope
    results.swConsole = swProbe.consoleMsgs

    finish(0)
  } catch (e) {
    results.error = String(e && e.stack)
    finish(1)
  }
})
