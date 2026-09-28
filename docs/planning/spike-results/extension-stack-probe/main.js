// Throwaway probe (no product code): can a preload's isolated world tell,
// from the JS call stack, whether a call into a contextBridge-exposed API
// came from extension code injected into the page's main world, or from
// the page's own code? See preload-wp.js and ext/*.js for the mechanics.
const { app, session, BrowserWindow } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const OUT = process.env.PROBE_OUT || path.join(__dirname, 'result.json')
const results = {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  calls: [],
  consoleWarnings: [],
  perf: null
}

const finish = (code) => {
  try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) } catch (e) {}
  app.exit(code)
}
setTimeout(() => { results.timedOut = true; finish(2) }, 100000)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function pageHtml (withInlineScript) {
  const inline = withInlineScript
    ? "<script>try{window.probeA&&window.probeA.call(location.pathname+'|case1-inline.A')}catch(e){};try{window.probeB&&window.probeB.call(location.pathname+'|case1-inline.B')}catch(e){};try{window.probeM&&window.probeM.call(location.pathname+'|case1-inline.M')}catch(e){}</script>"
    : ''
  return `<!doctype html><html><head><title>p</title></head><body>page<script src="/page.js"></script>${inline}</body></html>`
}

app.whenReady().then(async () => {
  try {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/page.js')) {
        res.setHeader('content-type', 'application/javascript')
        res.end(fs.readFileSync(path.join(__dirname, 'page.js')))
        return
      }
      res.setHeader('content-type', 'text/html')
      if (req.url.startsWith('/csp')) {
        res.setHeader('Content-Security-Policy', "script-src 'self'")
        res.end(pageHtml(true))
        return
      }
      res.end(pageHtml(true))
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port

    const ses = session.fromPartition('persist:stack-probe')
    const ext = await ses.extensions.loadExtension(path.join(__dirname, 'ext'))
    results.extId = ext.id

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, 'preload-wp.js')
      }
    })

    let currentUrl = ''
    win.webContents.on('console-message', (e) => {
      const level = e && e.level !== undefined ? e.level : 'log'
      const message = e && e.message !== undefined ? e.message : String(e)
      results.consoleWarnings.push({ url: currentUrl, level, message: String(message).slice(0, 400) })
    })

    const { ipcMain } = require('electron')
    ipcMain.on('probe:call', (_event, payload) => {
      results.calls.push(payload)
    })

    const plainUrl = `http://127.0.0.1:${port}/`
    const cspUrl = `http://127.0.0.1:${port}/csp`

    // Plain page: initial load (all manifest-declared routes fire), then a
    // reload to also catch chrome.scripting.registerContentScripts, which
    // only takes effect on the NEXT navigation of the tab.
    currentUrl = plainUrl
    await win.loadURL(plainUrl)
    await delay(2500)

    // Per-call cost of the structured CallSite capture: 1000 calls via
    // probeB (isolated-world capture) and probeM (main-world capture),
    // both in perf mode (no IPC per call, just returns the frame count).
    try {
      const perfJson = await win.webContents.executeJavaScript(`
        (function () {
          var n = 1000
          var startB = performance.now()
          for (var i = 0; i < n; i++) { window.probeB && window.probeB.call('perf', { perf: true }) }
          var elapsedB = performance.now() - startB
          var startM = performance.now()
          for (var j = 0; j < n; j++) { window.probeM && window.probeM.call('perf', { perf: true }) }
          var elapsedM = performance.now() - startM
          return JSON.stringify({
            isolatedWorld: { n: n, elapsedMs: elapsedB, perCallUs: (elapsedB * 1000) / n },
            mainWorld: { n: n, elapsedMs: elapsedM, perCallUs: (elapsedM * 1000) / n }
          })
        })()
      `)
      results.perf = JSON.parse(perfJson)
    } catch (e) {
      results.perf = { error: String(e) }
    }

    await win.loadURL(plainUrl)
    await delay(1500)

    // Strict-CSP page: same battery, same reload-for-registerContentScripts.
    currentUrl = cspUrl
    await win.loadURL(cspUrl)
    await delay(4000)
    await win.loadURL(cspUrl)
    await delay(2500)

    // Tamper cases (a)-(e): each is its own page load, ?t=<letter>, so
    // main-start-tamper.js applies exactly one tamper to the main-world
    // Error and calls all three probes once. Plain page, no CSP -- tamper
    // is a property-mutation question, not a script-execution-CSP one.
    for (const letter of ['a', 'b', 'c', 'd', 'e']) {
      const url = `${plainUrl}?t=${letter}`
      currentUrl = url
      await win.loadURL(url)
      await delay(1200)
    }

    finish(0)
  } catch (e) {
    results.error = String(e && e.stack)
    finish(1)
  }
})
