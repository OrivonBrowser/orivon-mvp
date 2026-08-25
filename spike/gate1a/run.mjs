// GATE 1a driver. Writes spike/results/gate-1a.json.
//
// THE QUESTION: does a renderer bundle fetch an ORDINARY (non-WebRTC) torrent?
// The audit called this the real risk of the whole spike. A naive renderer
// bundle is WebRTC-only, which is Brave parity -- exactly what ADR-0001
// reason 3 exists to beat.
//
// PASS = a piece verifies, from a local seeder configured with dht:false,
// tracker:false, lsd:false, utp:false, reached by explicit TCP address. With
// no signalling channel of any kind, a WebRTC peer cannot exist, so a verified
// piece is proof the bytes came over TCP through the shim.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { launchElectron } from '../launch.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(here, '..', 'results')
const seedInfoPath = join(tmpdir(), `orivon-gate1a-seed-${process.pid}.json`)

const stage = (m) => console.error(`[gate1a] ${m}`)

// --- 1. start the local TCP-only seeder -------------------------------------
stage('starting local seeder (dht/tracker/lsd/utp all disabled)')
rmSync(seedInfoPath, { force: true })
const seeder = spawn(
  process.execPath,
  [join(here, '..', 'fixtures', 'seeder.mjs'), '32', seedInfoPath],
  { stdio: ['ignore', 'ignore', 'inherit'] }
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
stage(`seeder up: infoHash ${seedInfo.infoHash} on TCP ${seedInfo.port}`)

// --- 2. run the renderer ----------------------------------------------------
let result
let shimCheck
try {
  stage('launching electron')
  const app = await launchElectron({ appPath: here })
  const page = await app.firstWindow()
  page.on('console', (m) => console.error(`[renderer] ${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => console.error(`[renderer] pageerror: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')

  // Wait for the module to register its globals.
  await page.waitForFunction(() => globalThis.__gate1a !== undefined, { timeout: 20000 })

  // The decisive precondition. torrent.js:2104 refuses to make ANY TCP
  // connection unless typeof net.connect === 'function'.
  shimCheck = await page.evaluate(() => globalThis.__gate1a.netIsShimmed())
  stage(`net shim: ${JSON.stringify(shimCheck)}`)

  stage('adding torrent and peer, waiting for a verified piece')
  result = await page.evaluate(
    (args) => globalThis.__gate1a.run(args),
    { magnetURI: seedInfo.magnetURI, peerAddr: `127.0.0.1:${seedInfo.port}`, timeoutMs: 60000 }
  )

  const versions = await app.evaluate(() => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome
  }))
  result.versions = versions
  await app.close()
} finally {
  seeder.kill('SIGTERM')
  rmSync(seedInfoPath, { force: true })
}

// --- 3. record --------------------------------------------------------------
const nonWebrtcWires = (result.wires ?? []).filter((w) => w.type !== 'webrtc')

const record = {
  gate: '1a',
  question: 'Does a renderer bundle fetch an ordinary (non-WebRTC) torrent over the shimmed net?',
  versions: result.versions,
  measuredAt: process.env['SPIKE_TIMESTAMP'] ?? null,
  seeder: {
    infoHash: seedInfo.infoHash,
    tcpPort: seedInfo.port,
    sizeBytes: seedInfo.sizeBytes,
    config: 'dht:false, tracker:false, lsd:false, utp:false - reachable only by explicit TCP address'
  },
  netShim: shimCheck,
  wires: result.wires,
  nonWebrtcWireCount: nonWebrtcWires.length,
  downloadedBytes: result.downloaded,
  progress: result.progress,
  elapsedMs: result.elapsedMs,
  timeline: result.events,
  verdict: result.verdict === 'PASS' && shimCheck.typeofConnect === 'function' ? 'PASS' : 'FAIL',
  note: result.verdict === 'PASS'
    ? 'No signalling channel existed, so a WebRTC peer was impossible. A verified piece proves TCP through the shim.'
    : `Renderer reported ${result.verdict}.`
}

mkdirSync(resultsDir, { recursive: true })
writeFileSync(join(resultsDir, 'gate-1a.json'), JSON.stringify(record, null, 2) + '\n')

console.log(JSON.stringify(record, null, 2))
console.log(`\nGATE 1a: ${record.verdict}`)
process.exit(record.verdict === 'PASS' ? 0 : 1)
