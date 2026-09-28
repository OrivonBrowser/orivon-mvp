// One-shot measurement probe: does net.fetch / session.fetch misbehave while
// an extension declaring webRequest / declarativeNetRequest is loaded in the
// session being fetched on? Not product code -- lives entirely outside
// orivon-mvp. All work happens inside app.whenReady().then(); no window is
// ever shown. Every step writes the results file immediately, so a native
// crash (segfault) still leaves a record of how far the run got.
import { app, session, net, BrowserWindow } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const PORT = Number(process.env.PROBE_PORT || 19457)
const URL = `http://127.0.0.1:${PORT}/x`
const EXT_DIR = process.env.PROBE_EXT_DIR || ''
const EXT_NAME = process.env.PROBE_EXT_NAME || 'none'
const SESSION_MODE = process.env.PROBE_SESSION_MODE || 'default' // 'default' | 'partition'
const RESULTS_FILE = process.env.PROBE_RESULTS_FILE
const EXTRA_LISTENER = process.env.PROBE_EXTRA_LISTENER === '1'
const RUN_ID = process.env.PROBE_RUN_ID || 'unlabeled'

if (!RESULTS_FILE) {
  console.error('PROBE_RESULTS_FILE is required')
  process.exit(2)
}
mkdirSync(dirname(RESULTS_FILE), { recursive: true })

const results = {
  runId: RUN_ID,
  extension: EXT_NAME,
  sessionMode: SESSION_MODE,
  extraEmbedderListener: EXTRA_LISTENER,
  port: PORT,
  startedAt: new Date().toISOString(),
  steps: [],
  finishedAt: null
}

function flush () {
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2))
}

function record (step, data) {
  results.steps.push({ step, at: new Date().toISOString(), ...data })
  console.log(`[step] ${step}: ${JSON.stringify(data)}`)
  flush()
}

function withTimeout (promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `timeout after ${ms}ms (${label})` }), ms))
  ])
}

async function tryFetch (fn, label) {
  record(`${label}-starting`, { ok: true })
  try {
    const resp = await fn()
    let bodyLen = -1
    try {
      const body = await resp.text()
      bodyLen = body.length
    } catch (e) {
      bodyLen = -1
    }
    record(label, { ok: true, status: resp.status, bodyLen })
  } catch (e) {
    record(label, { ok: false, error: String(e && e.stack ? e.stack : e) })
  }
}

function netRequestOnce (opts, label) {
  record(`${label}-starting`, { ok: true })
  return new Promise((resolve) => {
    try {
      const req = net.request(opts)
      let body = ''
      let settled = false
      const done = (r) => { if (!settled) { settled = true; resolve(r) } }
      req.on('response', (response) => {
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => done({ ok: true, status: response.statusCode, bodyLen: body.length }))
        response.on('error', (err) => done({ ok: false, error: String(err) }))
      })
      req.on('error', (err) => done({ ok: false, error: String(err) }))
      req.end()
    } catch (e) {
      resolve({ ok: false, error: String(e && e.stack ? e.stack : e) })
    }
  }).then((r) => record(label, r))
}

function loadPageOnce (webPreferences, label) {
  record(`${label}-starting`, { ok: true })
  return new Promise((resolve) => {
    let settled = false
    const win = new BrowserWindow({ show: false, webPreferences })
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
      try { win.destroy() } catch (e) { /* ignore */ }
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), 6000)
    win.webContents.once('did-finish-load', () => finish({ ok: true }))
    win.webContents.once('did-fail-load', (_e, code, desc) => finish({ ok: false, error: `${code} ${desc}` }))
    win.loadURL(URL).catch((e) => finish({ ok: false, error: String(e) }))
  }).then((r) => record(label, r))
}

process.on('uncaughtException', (err) => {
  record('uncaughtException', { ok: false, error: String(err && err.stack ? err.stack : err) })
  results.finishedAt = new Date().toISOString()
  flush()
  app.exit(1)
})
process.on('unhandledRejection', (err) => {
  record('unhandledRejection', { ok: false, error: String(err && err.stack ? err.stack : err) })
})

// Safety valve: if something hangs without crashing or throwing, don't let
// the run block the matrix forever.
const globalTimeout = setTimeout(() => {
  record('globalTimeout', { ok: false })
  results.finishedAt = new Date().toISOString()
  flush()
  app.exit(1)
}, 45000)

app.whenReady().then(async () => {
  record('appReady', { ok: true })

  const ses = SESSION_MODE === 'partition' ? session.fromPartition('persist:netfetch-probe') : session.defaultSession

  if (EXTRA_LISTENER) {
    ses.webRequest.onBeforeSendHeaders((details, callback) => callback({ cancel: false }))
    record('embedderListenerInstalled', { ok: true })
  }

  if (EXT_DIR) {
    try {
      const ext = await ses.loadExtension(EXT_DIR, { allowFileAccess: true })
      record('loadExtension', { ok: true, id: ext.id, name: ext.name })
    } catch (e) {
      record('loadExtension', { ok: false, error: String(e && e.stack ? e.stack : e) })
    }
    // Let the MV3 service worker (or MV2 background page) actually start.
    await new Promise((r) => setTimeout(r, 1200))
    record('waitedForServiceWorker', { ok: true })
  } else {
    record('loadExtension', { ok: true, skipped: true })
  }

  if (SESSION_MODE === 'default') {
    await tryFetch(() => withTimeout(net.fetch(URL), 8000, 'net.fetch'), 'net.fetch')
    await netRequestOnce({ url: URL }, 'net.request')
    await tryFetch(() => withTimeout(session.defaultSession.fetch(URL, { bypassCustomProtocolHandlers: true }), 8000, 'ses.fetch-bypass'), 'ses.fetch-bypass')
    await loadPageOnce({}, 'browserWindow-load')
  } else {
    // Control: net.fetch always targets the default session (no extension
    // loaded there in this run), so it should be unaffected -- included to
    // confirm the partition's extension doesn't leak into net.fetch.
    await tryFetch(() => withTimeout(net.fetch(URL), 8000, 'net.fetch-control'), 'net.fetch-control')
    await tryFetch(() => withTimeout(ses.fetch(URL), 8000, 'ses.fetch'), 'ses.fetch')
    await netRequestOnce({ url: URL, session: ses }, 'net.request-session')
    await tryFetch(() => withTimeout(ses.fetch(URL, { bypassCustomProtocolHandlers: true }), 8000, 'ses.fetch-bypass'), 'ses.fetch-bypass')
    await loadPageOnce({ partition: 'persist:netfetch-probe' }, 'browserWindow-load')
  }

  record('allStepsDone', { ok: true })
  results.finishedAt = new Date().toISOString()
  flush()
  clearTimeout(globalTimeout)
  app.exit(0)
}).catch((e) => {
  record('whenReadyRejected', { ok: false, error: String(e && e.stack ? e.stack : e) })
  results.finishedAt = new Date().toISOString()
  flush()
  app.exit(1)
})
