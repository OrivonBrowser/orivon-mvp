/**
 * Launches a packaged Orivon on a throwaway profile and passes once its shell page has rendered from
 * inside app.asar, so a release never carries a package that does not start. The release workflow runs
 * it against the installed deb, the AppImage, the NSIS install and the mounted dmg.
 *
 * Usage: node scripts/run-headless.mjs node scripts/smoke-packaged.mjs <executable>
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'

const STARTUP_TIMEOUT_MS = 120_000
const SHELL_PAGE = /app\.asar\/out\/renderer\/index\.html/
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
 * The shell's chrome page among DevTools targets: the window's own page, loaded from the packaged asar.
 * @param {Array<{ type: string, url: string, webSocketDebuggerUrl?: string }>} targets
 */
export function shellTarget (targets) {
  return targets.find((target) => target.type === 'page' && SHELL_PAGE.test(target.url) && target.webSocketDebuggerUrl !== undefined)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One Runtime.evaluate over a page's DevTools socket. */
async function evaluate (wsUrl, expression) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error(`no DevTools connection to ${wsUrl}`)) })
  try {
    const reply = new Promise((resolve) => { socket.onmessage = (event) => resolve(JSON.parse(String(event.data))) })
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    return (await reply).result?.result?.value
  } finally {
    socket.close()
  }
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
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])
      const shell = shellTarget(targets)
      if (shell !== undefined && await evaluate(shell.webSocketDebuggerUrl, RENDERED).catch(() => false) === true) return shell.url
    }
    await sleep(1000)
  }
  throw new Error(`no rendered shell page within ${STARTUP_TIMEOUT_MS / 1000} s`)
}

if (isInvokedDirectly(import.meta.url)) {
  const executable = process.argv[2]
  if (executable === undefined) {
    console.error('usage: node scripts/smoke-packaged.mjs <executable>')
    process.exit(1)
  }
  const profile = mkdtempSync(join(tmpdir(), 'orivon-packaged-'))
  const env = { ...process.env, ORIVON_INTRO: 'off', ORIVON_ETH_LIGHT_CLIENT: 'off', ORIVON_WINDOW_NO_FOCUS: '1', PULSE_SERVER: 'unix:/nonexistent' }
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
  } catch (error) {
    failed = true
    console.error(`[smoke-packaged] ${executable}: ${error.message}\n--- app output ---\n${log.split('\n').slice(-80).join('\n')}`)
  } finally {
    await stop(child)
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
  process.exit(failed ? 1 : 0)
}
