/**
 * `npm run perf:probe`: builds the ordinary app, runs it headless and silent on a fresh profile,
 * and measures each process's CPU and memory through a fixed set of scenes, so a change to a hot
 * path can be compared before and after. Linux only: it reads `/proc`. Pages are served on
 * loopback and nothing else resolves, except with `--light-client`, which measures the idle cost of
 * the Ethereum light client against its real endpoints. `--out <file>` sets where the JSON goes
 * (default `qa-artifacts/perf-probe.json`). CPU is percent of one core over the scene; memory is
 * PSS, so pages shared between processes count once.
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isInvokedDirectly, spawnCommandSync } from './cli.mjs'

const CLOCK_TICKS_PER_SECOND = 100
const DEFAULT_OUT = 'qa-artifacts/perf-probe.json'

/** User plus system CPU ticks from the text of `/proc/<pid>/stat`. @param {string} stat @returns {number} */
export function cpuTicksFromStat (stat) {
  // The command name is in parentheses and may itself contain spaces or parentheses.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return Number(fields[11]) + Number(fields[12])
}

/** The `Pss:` line of `/proc/<pid>/smaps_rollup`, in kB; 0 when absent. @param {string} rollup @returns {number} */
export function pssKbFromRollup (rollup) {
  const match = /^Pss:\s+(\d+)/m.exec(rollup)
  return match === null ? 0 : Number(match[1])
}

function readOr (path, fallback) {
  try { return readFileSync(path, 'utf8') } catch { return fallback }
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Loopback pages: `/static` sits still, `/ticker` retitles itself twice a second as a mail or chat tab's unread count does, `/heavy` loads 300 images. */
function startPages () {
  const icon = readFileSync('test/apps/extensions/commands/icon.png')
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://loopback')
    if (url.pathname === '/icon.png' || url.pathname === '/img') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(icon)
      return
    }
    const n = url.searchParams.get('n') ?? '0'
    const head = (title) => `<!doctype html><html><head><meta charset=utf-8><title>${title}</title><link rel=icon href="/icon.png?n=${n}"></head>`
    res.writeHead(200, { 'content-type': 'text/html' })
    if (url.pathname === '/heavy') {
      res.end(`${head(`heavy ${n}`)}<body>${Array.from({ length: 300 }, (_, k) => `<img width=8 height=8 src="/img?k=${k}&n=${n}">`).join('')}</body></html>`)
    } else if (url.pathname === '/ticker') {
      res.end(`${head(`ticker ${n}`)}<body><p>ticker</p><script>let i = 0; setInterval(() => { document.title = '(' + (++i) + ') ticker ${n}' }, 500)</script></body></html>`)
    } else {
      res.end(`${head(`static ${n}`)}<body><p>${'lorem ipsum '.repeat(200)}</p></body></html>`)
    }
  })
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(server) }) })
}

async function measure (options) {
  const { launchElectron, closeElectron, collectProcessTree } = await import('../test/support/launch-electron.mjs')
  const { findChrome, waitFor, HERMETIC_RESOLVER } = await import('../test/support/smoke-helpers.mjs')
  const server = await startPages()
  const origin = `http://127.0.0.1:${server.address().port}`
  const app = await launchElectron({
    appPath: '.',
    args: options.lightClient ? [] : [HERMETIC_RESOLVER],
    env: options.lightClient ? { ORIVON_ETH_LIGHT_CLIENT: 'on' } : {}
  })
  const results = { lightClient: options.lightClient, scenes: [] }
  try {
    await waitFor(() => { try { findChrome(app); return true } catch { return false } }, 30_000)
    const chrome = findChrome(app)
    const rootPid = app.process().pid
    // Counts what the main process sends the toolbar, by channel, and sizes one message in twenty.
    await app.evaluate(({ webContents }) => {
      globalThis.__perfProbe = { sends: {}, bytes: {}, sized: {} }
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().endsWith('/renderer/index.html')) continue
        const send = contents.send.bind(contents)
        contents.send = (channel, ...rest) => {
          const probe = globalThis.__perfProbe
          probe.sends[channel] = (probe.sends[channel] ?? 0) + 1
          if (probe.sends[channel] % 20 === 1) {
            probe.bytes[channel] = (probe.bytes[channel] ?? 0) + JSON.stringify(rest).length
            probe.sized[channel] = (probe.sized[channel] ?? 0) + 1
          }
          send(channel, ...rest)
        }
      }
    })
    const snapshot = async () => {
      const pids = [...new Set([rootPid, ...await collectProcessTree(rootPid)])]
      return Object.fromEntries(pids.map((pid) => [pid, {
        ticks: cpuTicksFromStat(readOr(`/proc/${pid}/stat`, ') x 0 0 0 0 0 0 0 0 0 0 0 0 0')),
        pssKb: pssKbFromRollup(readOr(`/proc/${pid}/smaps_rollup`, ''))
      }]))
    }
    const mainWrites = () => Number(/^wchar: (\d+)/m.exec(readOr(`/proc/${rootPid}/io`, 'wchar: 0'))?.[1] ?? 0)
    const scene = async (name, ms) => {
      const before = await snapshot()
      const writesBefore = mainWrites()
      await app.evaluate(() => { const probe = globalThis.__perfProbe; probe.sends = {}; probe.bytes = {}; probe.sized = {} })
      const started = Date.now()
      await delay(ms)
      const seconds = (Date.now() - started) / 1000
      const after = await snapshot()
      const facts = await app.evaluate(({ app: electronApp, webContents }) => ({
        metrics: electronApp.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? m.serviceName ?? '' })),
        views: webContents.getAllWebContents().flatMap((contents) => {
          try { return [{ pid: contents.getOSProcessId(), url: contents.getURL().replace(/^orivon-shell:\/\/renderer\//, 'renderer/').slice(0, 80) }] } catch { return [] }
        }),
        toolbar: globalThis.__perfProbe
      }))
      const processes = Object.entries(after).map(([pid, now]) => {
        const metric = facts.metrics.find((m) => String(m.pid) === pid)
        const then = before[pid] ?? now
        return {
          pid: Number(pid),
          kind: Number(pid) === rootPid ? 'main' : metric === undefined ? 'other' : `${metric.type}${metric.name === '' ? '' : `:${metric.name}`}`,
          cpuPct: Math.round((now.ticks - then.ticks) / CLOCK_TICKS_PER_SECOND / seconds * 1000) / 10,
          pssMb: Math.round(now.pssKb / 1024),
          views: facts.views.filter((v) => String(v.pid) === pid).map((v) => v.url)
        }
      }).sort((a, b) => b.cpuPct - a.cpuPct || b.pssMb - a.pssMb)
      const result = {
        name,
        seconds,
        processCount: processes.length,
        totalPssMb: processes.reduce((sum, p) => sum + p.pssMb, 0),
        totalCpuPct: Math.round(processes.reduce((sum, p) => sum + p.cpuPct, 0) * 10) / 10,
        mainWriteKb: Math.round((mainWrites() - writesBefore) / 1024),
        toolbarMessages: facts.toolbar.sends,
        toolbarBytesPerMessage: Object.fromEntries(Object.entries(facts.toolbar.bytes).map(([channel, bytes]) => [channel, Math.round(bytes / facts.toolbar.sized[channel])])),
        processes
      }
      const top = processes.slice(0, 3).map((p) => `${p.kind} ${p.cpuPct}%`).join(', ')
      console.log(`${name}: ${result.processCount} processes, ${result.totalPssMb} MB, ${result.totalCpuPct}% CPU (${top}), main wrote ${result.mainWriteKb} KB, toolbar messages ${JSON.stringify(result.toolbarMessages)}`)
      results.scenes.push(result)
    }
    const newTab = async (url) => { await chrome.evaluate((target) => { window.orivonShell.newTab(target) }, url) }

    await delay(5_000)
    if (options.lightClient) {
      await scene('fresh window, idle, light client on', 60_000)
      await scene('fresh window, idle, light client on, a minute later', 60_000)
    } else {
      await scene('fresh window, idle', 15_000)
      for (let i = 1; i <= 10; i++) { await newTab(`${origin}/static?n=${i}`); await delay(300) }
      await delay(8_000)
      await scene('10 static tabs, idle', 20_000)
      await newTab(`${origin}/ticker?n=1`)
      await delay(3_000)
      await scene('10 static tabs and a ticker tab in front', 20_000)
      for (let i = 11; i <= 31; i++) { await newTab(`${origin}/static?n=${i}`); await delay(250) }
      await delay(8_000)
      await scene('31 static tabs, ticker tab in the background', 20_000)
      await newTab(`${origin}/heavy?n=1`)
      await scene('the same, loading a page of 300 images', 10_000)
    }
  } finally {
    await closeElectron(app)
    server.close()
  }
  mkdirSync(dirname(options.out), { recursive: true })
  writeFileSync(options.out, `${JSON.stringify(results, null, 2)}\n`)
  console.log(`Wrote ${options.out}`)
}

/** @param {string[]} argv */
function parseArgs (argv) {
  const outAt = argv.indexOf('--out')
  return { run: argv.includes('--run'), lightClient: argv.includes('--light-client'), out: outAt === -1 ? DEFAULT_OUT : argv[outAt + 1] ?? DEFAULT_OUT }
}

if (isInvokedDirectly(import.meta.url)) {
  const argv = process.argv.slice(2)
  const options = parseArgs(argv)
  if (options.run) {
    await measure(options)
  } else {
    if (process.platform !== 'linux') { console.error('perf:probe reads /proc, so it runs on Linux only.'); process.exit(2) }
    const built = spawnCommandSync('node', ['scripts/build-ordinary.mjs'])
    if (built.error !== undefined || built.status !== 0) { console.error('The build failed; nothing was measured.'); process.exit(1) }
    const probed = spawnCommandSync('node', ['scripts/run-headless.mjs', 'node', 'scripts/perf-probe.mjs', '--run', ...argv])
    process.exit(probed.error === undefined ? probed.status ?? 1 : 1)
  }
}
