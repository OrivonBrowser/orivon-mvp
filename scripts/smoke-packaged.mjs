/**
 * Launches a packaged Orivon on a throwaway profile and passes once its shell page has rendered from
 * the shell scheme (served out of app.asar) and uBlock Origin runs in that new profile, so a release never carries a
 * package that does not start or that lost its bundled extension. The release workflow runs
 * it against the installed deb, the AppImage, the NSIS install and the mounted dmg.
 *
 * Usage: node scripts/run-headless.mjs node scripts/smoke-packaged.mjs <executable>
 *        node scripts/smoke-packaged.mjs --attach <port>
 * `--attach` checks an app somebody else started with `--remote-debugging-port=<port>`: the release workflow starts the
 * Windows Store package inside its package (Invoke-CommandInDesktopPackage), so the app has its package identity and
 * this script cannot be its parent.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'

// A native launch renders in about 10 s; an Intel build under Rosetta, translating Electron cold, can take minutes.
const STARTUP_TIMEOUT_MS = 300_000
const PROBE_TIMEOUT_MS = 5_000
// The bundled extension installs after the shell renders, while the window is already in use.
const BUNDLED_EXTENSION_MS = 60_000
const SHELL_PAGE = /^orivon-shell:\/\/renderer\/index\.html(?:[?#].*)?$/
const RENDERED = "document.readyState === 'complete' && document.body !== null && document.body.childElementCount > 0"

/**
 * The port Chromium's DevTools server listens on, read from the line it prints to stderr.
 * @param {string} output
 * @returns {number | undefined}
 */
export function devToolsPort (output) {
  const found = /DevTools listening on ws:\/\/[^/\s]+:(\d+)\//.exec(output)
  return found === null ? undefined : Number(found[1])
}

/**
 * The shell's chrome page among DevTools targets: the window's own page, loaded from the shell scheme's `renderer` host (the packaged app serves it out of app.asar).
 * @param {Array<{ type: string, url: string, webSocketDebuggerUrl?: string }>} targets
 */
export function shellTarget (targets) {
  return targets.find((target) => target.type === 'page' && SHELL_PAGE.test(target.url) && target.webSocketDebuggerUrl !== undefined)
}

/** uBlock Origin's id, from the key in the `.crx` resources/default-profile/bundled-extensions.json pins. */
export const BUNDLED_EXTENSION_ID = 'fkgkibajhfbepljeaefdnfnegdcjomkh'

/**
 * Whether a target of the bundled extension is running: a new profile starts with it installed (ADR-0066).
 * @param {Array<{ type: string, url: string }>} targets
 */
export function bundledExtensionRunning (targets) {
  return targets.some((target) => target.url.startsWith(`chrome-extension://${BUNDLED_EXTENSION_ID}/`))
}

/**
 * The port after `--attach`, or undefined when the arguments are not an attach request.
 * @param {string[]} argv the arguments after the script's name
 * @returns {number | undefined}
 */
export function attachPort (argv) {
  if (argv[0] !== '--attach' || !/^\d+$/.test(argv[1] ?? '')) return undefined
  const port = Number(argv[1])
  return port >= 1 && port <= 65535 ? port : undefined
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One Runtime.evaluate over a page's DevTools socket. Bounded: a page that reloads or crashes mid-call
 * closes the socket, and a stalled one never answers; either would otherwise hang past the deadline.
 */
function evaluate (wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const fail = (why) => { clearTimeout(timer); socket.close(); reject(new Error(why)) }
    const timer = setTimeout(() => fail('no DevTools answer in time'), PROBE_TIMEOUT_MS)
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    socket.onmessage = (event) => { clearTimeout(timer); socket.close(); resolve(JSON.parse(String(event.data)).result?.result?.value) }
    socket.onerror = () => fail(`DevTools connection to ${wsUrl} failed`)
    socket.onclose = () => fail('DevTools connection closed before an answer')
  })
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null

/**
 * Ends the app and everything it started (Chromium's helpers outlive a bare kill of the main process),
 * and waits for it: a dmg cannot be detached while one of its processes is still going.
 */
async function stop (child) {
  if (child.pid === undefined || exited(child)) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else try { process.kill(-child.pid, 'SIGKILL') } catch {}
  for (let waited = 0; !exited(child) && waited < 15_000; waited += 250) await sleep(250)
}

/** Resolves once the shell page has rendered; rejects with what the app printed if it never does. */
async function waitForShell (child, output, deadline) {
  while (Date.now() < deadline) {
    if (child.pid === undefined) throw new Error('the app could not be started')
    if (exited(child)) throw new Error(`the app exited (${child.exitCode ?? child.signalCode}) before its shell page rendered`)
    const port = devToolsPort(output())
    if (port !== undefined) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        .then((r) => r.json()).catch(() => [])
      const shell = shellTarget(targets)
      if (shell !== undefined && await evaluate(shell.webSocketDebuggerUrl, RENDERED).catch(() => false) === true) return shell.url
    }
    await sleep(1000)
  }
  throw new Error(`no rendered shell page within ${STARTUP_TIMEOUT_MS / 1000} s`)
}

/** Resolves once the bundled extension runs in the app on `port`; rejects naming what did run if it never does. */
async function waitForBundledExtension (port, deadline) {
  let targets = []
  while (Date.now() < deadline) {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      .then((r) => r.json()).catch(() => [])
    if (bundledExtensionRunning(targets)) return
    await sleep(1000)
  }
  throw new Error(`a new profile has no uBlock Origin running after ${BUNDLED_EXTENSION_MS / 1000} s; targets: ${targets.map((t) => t.url).join(', ')}`)
}

/** Resolves once the shell page of an app already running on `port` has rendered. */
async function attach (port) {
  // Nothing of ours to watch: the shape `waitForShell` reads, with the line Chromium prints for its DevTools port.
  const running = { pid: 1, exitCode: null, signalCode: null }
  const url = await waitForShell(running, () => `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/attached`, Date.now() + STARTUP_TIMEOUT_MS)
  console.log(`[smoke-packaged] port ${port}: shell page rendered (${url})`)
}

if (isInvokedDirectly(import.meta.url)) {
  const port = attachPort(process.argv.slice(2))
  if (process.argv[2] === '--attach') {
    if (port === undefined) {
      console.error('usage: node scripts/smoke-packaged.mjs --attach <port>')
      process.exit(1)
    }
    try {
      await attach(port)
      process.exit(0)
    } catch (error) {
      console.error(`[smoke-packaged] port ${port}: ${error.message}`)
      process.exit(1)
    }
  }
  const executable = process.argv[2]
  if (executable === undefined) {
    console.error('usage: node scripts/smoke-packaged.mjs <executable>')
    process.exit(1)
  }
  const profile = mkdtempSync(join(tmpdir(), 'orivon-packaged-'))
  const env = { ...process.env, ORIVON_INTRO: 'off', ORIVON_TELEMETRY: 'off', ORIVON_ETH_LIGHT_CLIENT: 'off', ORIVON_WINDOW_NO_FOCUS: '1', PULSE_SERVER: 'unix:/nonexistent' }
  delete env.ELECTRON_RUN_AS_NODE
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--alsa-output-device=null']
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  child.on('error', (error) => { log += `\n${error.message}` })

  let failed = false
  try {
    const url = await waitForShell(child, () => log, Date.now() + STARTUP_TIMEOUT_MS)
    console.log(`[smoke-packaged] ${executable}: shell page rendered (${url})`)
    await waitForBundledExtension(devToolsPort(log), Date.now() + BUNDLED_EXTENSION_MS)
    console.log(`[smoke-packaged] ${executable}: uBlock Origin installed in a new profile`)
  } catch (error) {
    failed = true
    console.error(`[smoke-packaged] ${executable}: ${error.message}\n--- app output ---\n${log.split('\n').slice(-80).join('\n')}`)
  } finally {
    await stop(child)
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
  process.exit(failed ? 1 : 0)
}
