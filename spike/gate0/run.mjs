// GATE 0 driver. Writes spike/results/gate-0.json.
//
// PASS: every structured-clone payload arrives byte-identical in BOTH
// directions, and sustained throughput at 256 KB is >= 50 MB/s. Fifty is
// ~25x the 1-5 MB/s that 1080p streaming needs, leaving room for the shim.
//
// Transferable ArrayBuffers are recorded as a FINDING, not a gate. If they
// are unavailable (electron#34905), build-plan.md's "day 2 with transferables"
// rescue for a gate-4 failure does not exist, and capability-api.md
// SS Throughput must drop its transferable language.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchElectron } from '../launch.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(here, '..', 'results')

const SIZES = [64 * 1024, 256 * 1024, 1024 * 1024]
const THROUGHPUT_SIZE = 256 * 1024
const THROUGHPUT_ITERATIONS = Number(process.env['GATE0_ITERATIONS'] ?? 400)
const MIN_MB_PER_SEC = 50

const stage = (label) => console.error(`[gate0] ${label}`)

stage('launching')
const app = await launchElectron({ appPath: join(here) })
const page = await app.firstWindow()
page.on('console', (m) => console.error(`[renderer] ${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => console.error(`[renderer] pageerror: ${e.message}`))
await page.waitForLoadState('domcontentloaded')

stage('opening port')
await page.evaluate(async () => {
  await globalThis.__gate0.open()
  // The port arrives on an ipcRenderer event; wait for the preload to hold it.
  for (let i = 0; i < 100 && !globalThis.__gate0.ready(); i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  if (!globalThis.__gate0.ready()) throw new Error('port never arrived in the preload')
})

const fidelityUp = []
const fidelityDown = []
const transfer = []

for (const size of SIZES) {
  stage(`fidelity up ${size}`)
  fidelityUp.push({
    sizeBytes: size,
    ...(await page.evaluate((s) => globalThis.__gate0.verifyUp(s), size))
  })

  stage(`fidelity down ${size}`)
  const down = await page.evaluate((s) => globalThis.__gate0.streamDown(s, 1), size)
  fidelityDown.push({
    sizeBytes: size,
    ok: down.firstBad === null && down.bytes === down.expectedBytes,
    reason: down.firstBad,
    received: down.bytes,
    expected: down.expectedBytes
  })

  stage(`transfer ${size}`)
  transfer.push({
    sizeBytes: size,
    ...(await page.evaluate((s) => globalThis.__gate0.transferUp(s), size))
  })
}

stage("throughput up")
const up = await page.evaluate(
  ([s, n]) => globalThis.__gate0.streamUp(s, n),
  [THROUGHPUT_SIZE, THROUGHPUT_ITERATIONS]
)
stage("throughput down")
const down = await page.evaluate(
  ([s, n]) => globalThis.__gate0.streamDown(s, n),
  [THROUGHPUT_SIZE, THROUGHPUT_ITERATIONS]
)

// process.versions.electron, NOT app.getVersion() -- the latter returns the
// version from the running app's package.json, which for this mini-app is
// 0.0.0 and tells us nothing about what was actually measured.
const versions = await app.evaluate(() => ({
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node
}))
await app.close()

const mbPerSec = (bytes, ms) => (bytes / 1e6) / (ms / 1000)

const throughput = {
  chunkBytes: THROUGHPUT_SIZE,
  iterations: THROUGHPUT_ITERATIONS,
  rendererToMain: {
    bytesReceived: up.bytes,
    bytesExpected: up.expectedBytes,
    complete: up.bytes === up.expectedBytes,
    ms: Math.round(up.ms),
    mbPerSec: Number(mbPerSec(up.bytes, up.ms).toFixed(1))
  },
  mainToRenderer: {
    bytesReceived: down.bytes,
    bytesExpected: down.expectedBytes,
    complete: down.bytes === down.expectedBytes,
    corruption: down.firstBad,
    ms: Math.round(down.ms),
    mbPerSec: Number(mbPerSec(down.bytes, down.ms).toFixed(1))
  }
}

const fidelityOk = fidelityUp.every((f) => f.ok) && fidelityDown.every((f) => f.ok)
const throughputOk =
  throughput.rendererToMain.complete &&
  throughput.mainToRenderer.complete &&
  throughput.rendererToMain.mbPerSec >= MIN_MB_PER_SEC &&
  throughput.mainToRenderer.mbPerSec >= MIN_MB_PER_SEC

const result = {
  gate: 0,
  question: 'Does MessagePortMain carry bytes intact between a sandboxed renderer and main, and how fast?',
  versions,
  platform: `${process.platform} ${process.arch}`,
  measuredAt: process.env['SPIKE_TIMESTAMP'] ?? null,
  criteria: { minMbPerSec: MIN_MB_PER_SEC },
  fidelityUp,
  fidelityDown,
  throughput,
  transferableFinding: {
    note: 'electron#34905. Recorded as a finding, not a gate.',
    results: transfer,
    available: transfer.every((t) => t.ok === true),
    outcomes: [...new Set(transfer.map((t) => t.outcome))]
  },
  verdict: fidelityOk && throughputOk ? 'PASS' : 'FAIL'
}

mkdirSync(resultsDir, { recursive: true })
writeFileSync(join(resultsDir, 'gate-0.json'), JSON.stringify(result, null, 2) + '\n')

console.log(JSON.stringify(result, null, 2))
console.log(`\nGATE 0: ${result.verdict}`)
process.exit(result.verdict === 'PASS' ? 0 : 1)
