// GATE 3 driver. Writes spike/results/gate-3.json.
//
// THE QUESTION: does MP4/H.264 play with seeking?
// PASS = plays end to end AND seeking to 75% starts playback there within 5s,
// without a full re-download from zero.
//
// The seeder is upload-throttled to 128 KB/s (verified separately: a full
// 2 MB download takes ~15s at that rate). Without the throttle, a fast local
// download could complete in well under a second regardless of whether
// seeking triggered anything intelligent, making the "resumes within 5s" test
// meaningless -- it would pass even if seeking silently downloaded everything.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { launchElectron } from '../launch.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(here, '..', 'results')
const seedInfoPath = join(tmpdir(), `orivon-gate3-seed-${process.pid}.json`)
const FIXTURE = '/tmp/orivon-fixture.mp4'
const UPLOAD_LIMIT_BPS = 131072 // 128 KB/s, verified: ~15s for the full 2MB fixture
const RESUME_PASS_MS = 5000

const stage = (m) => console.error(`[gate3] ${m}`)

stage(`starting throttled seeder for ${FIXTURE}`)
rmSync(seedInfoPath, { force: true })
const seeder = spawn(
  process.execPath,
  [join(here, '..', 'fixtures', 'seeder.mjs'), '--file', FIXTURE, seedInfoPath],
  { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ORIVON_UPLOAD_LIMIT: String(UPLOAD_LIMIT_BPS) } }
)

let seedInfo = null
for (let i = 0; i < 60; i++) {
  try { seedInfo = JSON.parse(readFileSync(seedInfoPath, 'utf8')); break } catch { /* not ready */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (seedInfo === null) {
  seeder.kill('SIGTERM')
  throw new Error('seeder never reported its info')
}
stage(`seeder up: infoHash ${seedInfo.infoHash} on TCP ${seedInfo.port}, throttled to ${UPLOAD_LIMIT_BPS} B/s`)

let result
let netShimCheck
let frameAtStart = null
let frameAfterSeek = null
try {
  stage('launching electron')
  const app = await launchElectron({ appPath: here })
  const page = await app.firstWindow()
  page.on('console', (m) => console.error(`[renderer] ${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => console.error(`[renderer] pageerror: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => globalThis.__gate3 !== undefined, { timeout: 20000 })

  netShimCheck = await page.evaluate(() => globalThis.__gate3.netIsShimmed())
  stage(`net shim: ${JSON.stringify(netShimCheck)}`)

  stage('playing, seeking, measuring resume latency')
  const runPromise = page.evaluate(
    (args) => globalThis.__gate3.run(args),
    { magnetURI: seedInfo.magnetURI, peerAddr: `127.0.0.1:${seedInfo.port}`, seekFraction: 0.75, timeoutMs: 60000 }
  )

  // Capture a frame shortly after first playback starts (before the seek),
  // and again once the run resolves (after the seek + resume). Both are read
  // back with the Read tool afterward to confirm the burned-in frame number.
  await page.waitForFunction(() => {
    const v = document.querySelector('#player')
    return v && v.readyState >= 2 && v.currentTime > 0.2
  }, { timeout: 30000 }).catch(() => stage('WARNING: pre-seek frame wait timed out, capturing anyway'))
  frameAtStart = await page.evaluate(() => globalThis.__gate3.captureFrame())

  result = await runPromise

  frameAfterSeek = await page.evaluate(() => globalThis.__gate3.captureFrame())

  await app.close()
} finally {
  seeder.kill('SIGTERM')
  rmSync(seedInfoPath, { force: true })
}

mkdirSync(resultsDir, { recursive: true })

const saveFrame = (dataUrl, name) => {
  if (!dataUrl) return null
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '')
  const path = join(resultsDir, name)
  writeFileSync(path, Buffer.from(b64, 'base64'))
  return path
}
const startFramePath = saveFrame(frameAtStart, 'gate-3-frame-before-seek.png')
const seekFramePath = saveFrame(frameAfterSeek, 'gate-3-frame-after-seek.png')

const resumeWithinBudget = result.resumeLatencyMs !== null && result.resumeLatencyMs <= RESUME_PASS_MS
const seekWasNotFullDownload =
  result.downloadedAtResume !== null && result.totalBytes !== null &&
  result.downloadedAtResume < result.totalBytes * 0.95 // some slack for prefetch around the seek point

const record = {
  gate: 3,
  question: 'Does MP4/H.264 play with seeking?',
  measuredAt: process.env['SPIKE_TIMESTAMP'] ?? null,
  fixture: {
    path: FIXTURE,
    generatedWith: 'ffmpeg testsrc, 640x480, 25fps, 60s, libx264 baseline, +faststart, burned-in FRAME %{n} counter',
    sizeBytes: seedInfo.sizeBytes
  },
  seeder: {
    uploadLimitBps: UPLOAD_LIMIT_BPS,
    note: 'Throttled so a full download takes ~15s -- verified separately -- making a sub-5s resume after a seek meaningful evidence rather than a coincidence of fast loopback.'
  },
  netShim: netShimCheck,
  mediaPath: 'service-worker createServer (file:// was confirmed a secure context in this Electron build; see gate-3-sw-probe.json)',
  timeToFirstFrameMs: result.timeToFirstFrameMs,
  seekIssuedAtMs: result.seekIssuedAt,
  resumedAtMs: result.resumedAtMs,
  resumeLatencyMs: result.resumeLatencyMs,
  downloadedAtSeekBytes: result.downloadedAtSeek,
  downloadedAtResumeBytes: result.downloadedAtResume,
  totalBytes: result.totalBytes,
  resumeWithinBudget,
  seekWasNotFullDownload,
  framesSavedTo: { beforeSeek: startFramePath, afterSeek: seekFramePath },
  timeline: result.events,
  error: result.error ?? null,
  verdict: (result.verdict === 'PASS' && resumeWithinBudget && seekWasNotFullDownload) ? 'PASS' : 'FAIL',
  note: 'Frame images saved for manual verification of the burned-in FRAME N counter -- currentTime alone can be set without any decoding happening, so the actual rendered frame is the real check.'
}

writeFileSync(join(resultsDir, 'gate-3.json'), JSON.stringify(record, null, 2) + '\n')

console.log(JSON.stringify(record, null, 2))
console.log(`\nGATE 3: ${record.verdict}`)
process.exit(record.verdict === 'PASS' ? 0 : 1)
