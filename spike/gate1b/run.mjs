// GATE 1b driver. Writes spike/results/gate-1b.json.
//
// THE QUESTION: does a DHT lookup complete over the shimmed dgram?
//
// DHT is how ADR-0001's "ordinary torrents" claim is met without trackers, and
// it is the half of gate 1 that exercises message-oriented (rather than
// stream) transport.
//
// The gate runs against a LOCAL DHT node, deliberately. The public DHT is
// unreachable from this environment -- verified 2026-08-25: outbound UDP works
// (a DNS query to 8.8.8.8 answers in 61 bytes) but router.bittorrent.com:6881
// never replies. Testing against it would measure the network, not the shim.
// The public leg is reported separately and must be re-run on a normal network.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { launchElectron } from '../launch.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(here, '..', 'results')
const dhtInfoPath = join(tmpdir(), `orivon-gate1b-dht-${process.pid}.json`)

const stage = (m) => console.error(`[gate1b] ${m}`)

// --- 1. start the local DHT node -------------------------------------------
stage('starting local DHT node (bootstrap:false, standalone)')
rmSync(dhtInfoPath, { force: true })
const dhtNode = spawn(
  process.execPath,
  [join(here, '..', 'fixtures', 'dht-node.mjs'), dhtInfoPath],
  { stdio: ['ignore', 'ignore', 'inherit'] }
)

let dhtInfo = null
for (let i = 0; i < 60; i++) {
  try { dhtInfo = JSON.parse(readFileSync(dhtInfoPath, 'utf8')); break } catch { /* not ready */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (dhtInfo === null) {
  dhtNode.kill('SIGTERM')
  throw new Error('local DHT node never reported its info')
}
stage(`DHT node up on 127.0.0.1:${dhtInfo.port}, holding ${dhtInfo.infoHash.slice(0, 12)}`)

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
  await page.waitForFunction(() => globalThis.__gate1b !== undefined, { timeout: 20000 })

  shimCheck = await page.evaluate(() => globalThis.__gate1b.dgramIsShimmed())
  stage(`dgram shim: ${JSON.stringify(shimCheck)}`)

  stage('bootstrapping DHT and looking up the infohash')
  result = await page.evaluate(
    (args) => globalThis.__gate1b.run(args),
    {
      bootstrap: [`127.0.0.1:${dhtInfo.port}`],
      infoHashHex: dhtInfo.infoHash,
      timeoutMs: 60000
    }
  )

  result.versions = await app.evaluate(() => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome
  }))
  await app.close()
} finally {
  dhtNode.kill('SIGTERM')
  rmSync(dhtInfoPath, { force: true })
}

// --- 3. record --------------------------------------------------------------
const record = {
  gate: '1b',
  question: 'Does a DHT lookup complete over the shimmed dgram?',
  versions: result.versions,
  measuredAt: process.env['SPIKE_TIMESTAMP'] ?? null,
  localDht: {
    host: dhtInfo.host,
    port: dhtInfo.port,
    infoHash: dhtInfo.infoHash,
    announcedPeerPort: dhtInfo.announcedPeerPort,
    config: 'bootstrap:false standalone node, announcing one infohash'
  },
  dgramShim: shimCheck,
  peersFound: result.peers,
  elapsedMs: result.elapsedMs,
  error: result.error ?? null,
  stack: result.stack ?? null,
  timeline: result.events,
  publicDhtLeg: {
    attempted: false,
    reason:
      'Public DHT is unreachable from this environment. Verified: outbound UDP works ' +
      '(DNS query to 8.8.8.8 answered, 61 bytes) but router.bittorrent.com:6881 never ' +
      'replied within 8s. MUST be re-run on a normal network before the DHT story is ' +
      'considered fully proven.'
  },
  verdict:
    result.verdict === 'PASS' && shimCheck.typeofCreateSocket === 'function'
      ? 'PASS'
      : 'FAIL',
  note:
    result.verdict === 'PASS'
      ? 'Real KRPC-over-UDP traffic (bencoded queries and responses) crossed the shimmed dgram, ' +
        'and a lookup returned the announced peer.'
      : `Renderer reported ${result.verdict}.`
}

mkdirSync(resultsDir, { recursive: true })
writeFileSync(join(resultsDir, 'gate-1b.json'), JSON.stringify(record, null, 2) + '\n')

console.log(JSON.stringify(record, null, 2))
console.log(`\nGATE 1b: ${record.verdict}`)
process.exit(record.verdict === 'PASS' ? 0 : 1)
