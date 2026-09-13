// A59 probe -- throwaway, not shipped source. Never imported from src/, never
// modernised. See docs/open-questions.md A59 for the question this answers
// and for the dated result block this run's output was copied into.
//
// Measures, by direct observation rather than by reading electron.d.ts's
// one-line "incorrect" warning, whether net.fetch's Response.url can differ
// from the URL actually requested on an ORDINARY (non-redirected, 200 OK)
// fetch -- against a real local http AND https server, from a real Electron
// main process. Mirrors electron-fetch.ts's own fetch options
// (credentials: 'omit', redirect: 'error') so this measures the exact
// configuration production uses, not a more permissive one.
//
// Never launched directly -- see .claude/skills/orivon-electron/SKILL.md.
// This file assumes ELECTRON_RUN_AS_NODE was already stripped by the caller
// and self-verifies it got real Electron (app.getVersion, MessageChannelMain)
// before trusting anything else it measures.
const { app, net, MessageChannelMain } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const path = require('node:path')
const { makeSelfSignedCert, startServers, tryBindPrivilegedPort } = require('./server.cjs')
const { httpCases, httpsCases } = require('./cases.cjs')

const RESULTS_DIR = path.join(__dirname, '..', 'results')
const RESULT_PATH = path.join(RESULTS_DIR, 'a59-response-url.json')

/** WHATWG-canonical form of what was requested, fragment stripped (fetch
 * never sends a fragment to the network, so Response.url can never carry
 * one either -- that is expected browser behaviour, not part of what A59
 * asks about). Returns null for a URL shape `net.fetch` may reject before a
 * Response ever exists (e.g. embedded userinfo). */
function expectedUrl (requested) {
  try {
    const u = new URL(requested)
    u.hash = ''
    return u.href
  } catch {
    return null
  }
}

async function runCase ({ label, url }) {
  const expected = expectedUrl(url)
  const record = { label, requested: url, expected }
  try {
    const response = await net.fetch(url, { credentials: 'omit', redirect: 'error' })
    record.status = response.status
    record.type = response.type
    record.redirected = response.redirected
    record.reportedUrl = response.url
    record.matchesExpected = expected !== null && response.url === expected
    try {
      const body = await response.json()
      record.serverSaw = body
    } catch (e) {
      record.serverSawError = String((e && e.message) || e)
    }
  } catch (e) {
    record.threw = { name: e && e.name, message: String((e && e.message) || e) }
  }
  return record
}

async function main () {
  mkdirSync(RESULTS_DIR, { recursive: true })

  const realLaunch = typeof app.getVersion === 'function' && typeof MessageChannelMain === 'function'
  const out = {
    probe: 'a59-response-url',
    realLaunch,
    electronVersion: realLaunch ? process.versions.electron : null,
    chromeVersion: realLaunch ? process.versions.chrome : null
  }

  if (!realLaunch) {
    out.error = 'not a real Electron launch (ELECTRON_RUN_AS_NODE poisoning suspected) -- refusing to record any further result'
    writeFileSync(RESULT_PATH, JSON.stringify(out, null, 2))
    console.error('[a59-probe] REFUSING TO TRUST THIS RUN -- not real Electron')
    process.exit(1)
  }

  // The cert has to exist, and its SPKI hash has to be registered, before
  // `app.whenReady()` -- `appendSwitch` has no effect once Chromium has
  // already started up. Trusting one exact, freshly-generated key by its
  // SPKI hash (Chromium's own `--ignore-certificate-errors-spki-list`) is
  // deliberately narrower than disabling certificate verification: nothing
  // else -- no other host, no other cert -- is trusted by this switch. See
  // server.cjs's own comment on `makeSelfSignedCert` for why this is the
  // mechanism rather than `setCertificateVerifyProc`.
  const certInfo = makeSelfSignedCert()
  app.commandLine.appendSwitch('ignore-certificate-errors-spki-list', certInfo.spkiHashBase64)

  await app.whenReady()

  const { httpPort, httpsPort, stop } = await startServers(certInfo)
  out.httpPort = httpPort
  out.httpsPort = httpsPort

  // Best-effort, answered directly rather than assumed: can this environment
  // even bind a real default port?
  out.privilegedPortProbe = {
    port80: await tryBindPrivilegedPort(80),
    port443: await tryBindPrivilegedPort(443)
  }

  const cases = [...httpCases(httpPort), ...httpsCases(httpsPort)]
  const results = []
  for (const c of cases) {
    results.push(await runCase(c))
  }
  out.results = results

  const mismatches = results.filter((r) => r.expected !== null && !r.threw && r.matchesExpected === false)
  out.verdict = {
    totalCases: results.length,
    thrown: results.filter((r) => r.threw).length,
    mismatches: mismatches.length,
    mismatchLabels: mismatches.map((r) => r.label),
    summary: mismatches.length === 0
      ? 'response.url matched the WHATWG-canonical form of the requested URL (fragment stripped) in every case that returned a Response.'
      : `response.url DIFFERED from the requested URL in ${mismatches.length} case(s): ${mismatches.map((r) => r.label).join(', ')}.`
  }

  writeFileSync(RESULT_PATH, JSON.stringify(out, null, 2))
  console.log('[a59-probe] wrote', RESULT_PATH)

  console.log('\nrequested -> reported (label: match)')
  for (const r of results) {
    if (r.threw) {
      console.log(`  ${r.label}: THREW ${r.threw.name}: ${r.threw.message}`)
    } else {
      console.log(`  ${r.label}: ${r.matchesExpected ? 'MATCH' : 'MISMATCH'}`)
      console.log(`      requested: ${r.requested}`)
      console.log(`      reported:  ${r.reportedUrl}`)
    }
  }
  console.log(`\nVERDICT: ${out.verdict.summary}`)

  await stop()
  app.exit(realLaunch && mismatches.length === 0 ? 0 : realLaunch ? 2 : 1)
}

main().catch((e) => {
  console.error('[a59-probe] FATAL', e)
  try {
    mkdirSync(RESULTS_DIR, { recursive: true })
    writeFileSync(RESULT_PATH, JSON.stringify({ error: String((e && e.stack) || e) }, null, 2))
  } catch { /* best effort */ }
  app.exit(1)
})
