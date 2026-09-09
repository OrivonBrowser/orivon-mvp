// ADR-0007 probe -- throwaway, not shipped source.
//
// Confirms, by direct measurement rather than by argument, the four things
// ADR-0007 (docs/decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md,
// lines 86-92 and its Reversibility section) lists as "assumed, not yet
// confirmed":
//
//   1. Electron can intercept a standard scheme (https) PER-SESSION --
//      session.fromPartition(...).protocol.handle('https', ...) -- not
//      globally on defaultSession.
//   2. It can serve a streaming, range-capable response through that handler.
//   3. The origin remains a secure context -- service workers still register
//      and reach 'ready' there.
//   4. onHeadersReceived fires for such a response, and a header it injects
//      is actually visible to the page.
//
// Mirrors the real shell's naming: partitionFor() in
// src/broker/grants/origin-hash.ts builds `persist:app-<sha256hex(origin)>`.
// Reproduced here by hand (not imported -- this is a throwaway JS probe, the
// real function is TypeScript) so the partition this probe intercepts on is
// the same SHAPE the shell actually uses, per the build brief.
//
// Never launched directly -- see .claude/skills/orivon-electron/SKILL.md.
// This file assumes ELECTRON_RUN_AS_NODE was already stripped by the caller
// and self-verifies it got real Electron (app.getVersion, MessageChannelMain)
// before trusting anything else it measures.
const { app, BrowserWindow, session, MessageChannelMain } = require('electron')
const { createHash } = require('node:crypto')
const { writeFileSync, mkdirSync } = require('node:fs')
const path = require('node:path')

const PROBE_ORIGIN = 'https://adr7-probe.orivon.test' // .test is IANA-reserved, never resolves for real
const PARTITION = `persist:app-${createHash('sha256').update(PROBE_ORIGIN, 'utf8').digest('hex')}`
const RESULTS_DIR = path.join(__dirname, '..', 'results')
const RESULT_PATH = path.join(RESULTS_DIR, 'adr7-probe.json')
const SCREENSHOT_PATH = path.join(RESULTS_DIR, 'adr7-probe-screenshot.png')

// A 2 MiB deterministic buffer so a ranged read's byte content is verifiable,
// not just its length.
const ASSET = Buffer.alloc(2 * 1024 * 1024)
for (let i = 0; i < ASSET.length; i++) ASSET[i] = i % 256

const INDEX_HTML = `<!doctype html>
<html><body>
<script>
async function run () {
  const result = { isSecureContext: window.isSecureContext }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    result.serviceWorker = { registered: true, scope: reg.scope }
  } catch (e) {
    result.serviceWorker = { registered: false, error: String(e && e.message || e) }
  }
  try {
    const full = await fetch('/asset.bin')
    const fullBuf = await full.arrayBuffer()
    const ranged = await fetch('/asset.bin', { headers: { Range: 'bytes=100-199' } })
    const rangedBuf = new Uint8Array(await ranged.arrayBuffer())
    let rangedBytesCorrect = rangedBuf.length === 100
    for (let i = 0; i < rangedBuf.length && rangedBytesCorrect; i++) {
      if (rangedBuf[i] !== (100 + i) % 256) rangedBytesCorrect = false
    }
    result.streaming = {
      fullStatus: full.status,
      fullLength: fullBuf.byteLength,
      rangedStatus: ranged.status,
      rangedLength: rangedBuf.length,
      rangedBytesCorrect,
      contentRange: ranged.headers.get('content-range'),
      onHeadersReceivedMarker: full.headers.get('x-adr7-marker')
    }
  } catch (e) {
    result.streaming = { error: String(e && e.message || e) }
  }
  window.__probeResult = result
}
run()
</script>
</body></html>`

const SW_JS = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
`

/** A genuinely chunked, pull-based ReadableStream over `buf` -- exercises
 * the streaming claim rather than wrapping one static buffer in a stream
 * interface. */
function streamOf (buf) {
  const CHUNK = 64 * 1024
  let offset = 0
  return new ReadableStream({
    pull (controller) {
      if (offset >= buf.length) { controller.close(); return }
      const end = Math.min(offset + CHUNK, buf.length)
      controller.enqueue(buf.subarray(offset, end))
      offset = end
    }
  })
}

function makeHandler () {
  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(INDEX_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    }
    if (url.pathname === '/sw.js') {
      return new Response(SW_JS, { status: 200, headers: { 'content-type': 'application/javascript' } })
    }
    if (url.pathname === '/asset.bin') {
      const total = ASSET.length
      const range = request.headers.get('range')
      if (range !== null) {
        const m = /^bytes=(\d+)-(\d+)?$/.exec(range)
        if (m !== null) {
          const start = Number(m[1])
          const end = m[2] !== undefined ? Number(m[2]) : total - 1
          const chunk = ASSET.subarray(start, end + 1)
          return new Response(streamOf(chunk), {
            status: 206,
            headers: {
              'content-type': 'application/octet-stream',
              'content-range': `bytes ${start}-${end}/${total}`,
              'content-length': String(chunk.length),
              'accept-ranges': 'bytes'
            }
          })
        }
      }
      return new Response(streamOf(ASSET), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(total),
          'accept-ranges': 'bytes'
        }
      })
    }
    return new Response('not found', { status: 404 })
  }
}

async function waitForResult (wc, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await wc.executeJavaScript('window.__probeResult ?? null')
    if (value !== null) return value
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

async function main () {
  mkdirSync(RESULTS_DIR, { recursive: true })

  const realLaunch = typeof app.getVersion === 'function' && typeof MessageChannelMain === 'function'
  const out = {
    probeOrigin: PROBE_ORIGIN,
    partition: PARTITION,
    realLaunch,
    electronVersion: realLaunch ? process.versions.electron : null
  }

  if (!realLaunch) {
    out.error = 'not a real Electron launch (ELECTRON_RUN_AS_NODE poisoning suspected) -- refusing to record any further result'
    writeFileSync(RESULT_PATH, JSON.stringify(out, null, 2))
    console.error('[adr7-probe] REFUSING TO TRUST THIS RUN -- not real Electron')
    process.exit(1)
  }

  await app.whenReady()

  let headersReceivedFired = false
  const appSession = session.fromPartition(PARTITION)
  appSession.protocol.handle('https', makeHandler())
  appSession.webRequest.onHeadersReceived((details, callback) => {
    headersReceivedFired = true
    const headers = { ...details.responseHeaders, 'x-adr7-marker': ['yes'] }
    callback({ responseHeaders: headers })
  })

  // --- Assumption 1, positive half: the app partition serves the intercepted origin.
  const win = new BrowserWindow({
    show: true,
    width: 800,
    height: 600,
    webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false }
  })

  const loaded = new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => resolve(true))
    win.webContents.once('did-fail-load', (_e, code, desc) => resolve({ failed: true, code, desc }))
  })
  win.loadURL(PROBE_ORIGIN + '/')
  out.appSessionLoad = await loaded

  const pageResult = out.appSessionLoad === true ? await waitForResult(win.webContents, 15000) : null
  out.pageResult = pageResult
  out.headersReceivedListenerInvoked = headersReceivedFired

  // Proof the window is REAL, not a headless stand-in: capture actual
  // rendered pixels. Run under xvfb-run -a for a genuine X display.
  try {
    const image = await win.webContents.capturePage()
    writeFileSync(SCREENSHOT_PATH, image.toPNG())
    out.screenshotBytes = image.toPNG().length
  } catch (e) {
    out.screenshotError = String(e && e.message || e)
  }

  // --- Assumption 1, negative half: the SAME url must NOT be reachable
  // through the plain default session, which never registered a handler for
  // it and never should silently fall through to one that did.
  const win2 = new BrowserWindow({
    show: false,
    webPreferences: { session: session.defaultSession, contextIsolation: true, sandbox: true }
  })
  const defaultLoaded = new Promise((resolve) => {
    win2.webContents.once('did-finish-load', () => resolve({ leaked: true }))
    win2.webContents.once('did-fail-load', (_e, code, desc) => resolve({ leaked: false, code, desc }))
  })
  win2.loadURL(PROBE_ORIGIN + '/')
  out.defaultSessionLoad = await Promise.race([
    defaultLoaded,
    new Promise((resolve) => setTimeout(() => resolve({ leaked: false, code: 'TIMEOUT', desc: 'no event within 8s' }), 8000))
  ])

  // --- Assemble the four ADR-0007 verdicts explicitly.
  out.verdicts = {
    assumption1_perSessionInterception: {
      appPartitionServed: out.appSessionLoad === true,
      defaultSessionLeaked: out.defaultSessionLoad.leaked === true,
      pass: out.appSessionLoad === true && out.defaultSessionLoad.leaked !== true
    },
    assumption2_streamingRangeCapable: pageResult?.streaming ?? null,
    assumption3_secureContextServiceWorker: {
      isSecureContext: pageResult?.isSecureContext ?? null,
      serviceWorker: pageResult?.serviceWorker ?? null,
      pass: pageResult?.isSecureContext === true && pageResult?.serviceWorker?.registered === true
    },
    assumption4_onHeadersReceivedFires: {
      listenerInvoked: headersReceivedFired,
      markerVisibleToPage: pageResult?.streaming?.onHeadersReceivedMarker === 'yes',
      pass: headersReceivedFired && pageResult?.streaming?.onHeadersReceivedMarker === 'yes'
    }
  }

  writeFileSync(RESULT_PATH, JSON.stringify(out, null, 2))
  console.log('[adr7-probe] wrote', RESULT_PATH)
  console.log(JSON.stringify(out.verdicts, null, 2))

  win.destroy()
  win2.destroy()
  app.quit()
}

main().catch((e) => {
  console.error('[adr7-probe] FATAL', e)
  try {
    mkdirSync(RESULTS_DIR, { recursive: true })
    writeFileSync(RESULT_PATH, JSON.stringify({ error: String(e && e.stack || e) }, null, 2))
  } catch { /* best effort */ }
  app.exit(1)
})
