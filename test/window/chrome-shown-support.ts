// What the specs that read the chrome page's visibility share: the shell launched with an inspector on its main process and
// nothing driving its pages (Playwright keeps every page visible, which hides the very state these specs look for), and the
// reading of the chrome and of the overlays on screen through that inspector.
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const electronPath = createRequire(import.meta.url)('electron') as string
/** Both fit the 1280 by 1024 display the headless runner gives; the second is larger than the window's first size. */
const SMALL = { x: 0, y: 0, width: 700, height: 500 }
const RESIZED = { x: 0, y: 0, width: 1200, height: 900 }

export interface Inspector { evaluate: (expression: string) => Promise<unknown>, close: () => void }

async function inspectorUrl (child: ChildProcess): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let seen = ''
    const timer = setTimeout(() => { reject(new Error(`no inspector address in: ${seen.slice(-400)}`)) }, 30_000)
    child.stderr?.on('data', (chunk: Buffer) => {
      seen += String(chunk)
      const found = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(seen)
      if (found !== null) { clearTimeout(timer); resolve(found[0]) }
    })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('the shell exited before the inspector opened')) })
  })
}

async function connect (url: string): Promise<Inspector> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => { resolve() }); socket.addEventListener('error', () => { reject(new Error('inspector refused')) }) })
  let next = 0
  const waiting = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
  socket.addEventListener('message', (event) => {
    const reply = JSON.parse(String(event.data)) as { id?: number, result?: { result?: { value?: unknown }, exceptionDetails?: unknown } }
    const entry = reply.id === undefined ? undefined : waiting.get(reply.id)
    if (reply.id === undefined || entry === undefined) return
    waiting.delete(reply.id)
    if (reply.result?.exceptionDetails !== undefined) entry.reject(new Error(JSON.stringify(reply.result.exceptionDetails)))
    else entry.resolve(reply.result?.result?.value)
  })
  return {
    evaluate: async (expression) => await new Promise<unknown>((resolve, reject) => {
      next += 1
      waiting.set(next, { resolve, reject })
      socket.send(JSON.stringify({ id: next, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    }),
    close: () => { socket.close() }
  }
}

export const sleep = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }

/** Runs `body` in the main process with `chrome` the chrome page's webContents and `win` the window. */
export const inMain = (body: string): string => `(async () => {
  const { BaseWindow, webContents } = process.mainModule.require('electron')
  const win = BaseWindow.getAllWindows()[0]
  const chrome = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/renderer/index.html'))
  ${body}
})()`

/** What the chrome page says about itself: whether it is visible, and how many animation frames it ran in half a second. */
const CHROME_STATE = inMain(`return await chrome.executeJavaScript(\`new Promise((resolve) => {
  let frames = 0; const t0 = performance.now()
  const tick = () => { frames += 1; if (performance.now() - t0 < 500) requestAnimationFrame(tick); else resolve({ visibility: document.visibilityState, frames }) }
  requestAnimationFrame(tick); setTimeout(() => resolve({ visibility: document.visibilityState, frames: -1 }), 2500)
})\`)`)

/** The overlays on screen, by the name in their page's address. */
export const SHOWN_OVERLAYS = inMain(`return win.contentView.children.filter((v) => v.webContents && v.getVisible()).map((v) => /overlay=([a-z-]+)/.exec(v.webContents.getURL())?.[1]).filter((name) => name !== undefined)`)

export interface Shell { main: Inspector, close: () => Promise<void> }

/** The shell on a throwaway profile with an inspector on its main process and nothing on its pages, its names and `ipfs://` sites served by `gateway`. */
export async function launchShell (gateway: { url: string }): Promise<Shell> {
  const dir = await mkdtemp(join(tmpdir(), 'orivon-chrome-shown-'))
  const env = {
    ...process.env, PULSE_SERVER: 'unix:/nonexistent', ORIVON_WINDOW_NO_FOCUS: '1', ORIVON_ETH_LIGHT_CLIENT: 'off', ORIVON_INTRO: 'off', ORIVON_UPDATE_CHECK: 'off', ORIVON_SECURE_DNS: 'off',
    ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_DOH: `${gateway.url}/dns-query`
  } as Record<string, string | undefined>
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronPath, ['.', `--user-data-dir=${dir}`, '--inspect=0', '--no-sandbox', '--alsa-output-device=null', HERMETIC_RESOLVER], { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let inspector: Inspector | undefined
  const close = async (): Promise<void> => {
    inspector?.close()
    // The whole tree: the shell's other processes hold files of the profile open until they are gone.
    try {
      if (child.pid !== undefined) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        else process.kill(-child.pid, 'SIGKILL')
      }
    } catch { /* already gone */ }
    await sleep(500)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
  try {
    inspector = await connect(await inspectorUrl(child))
    const main = inspector
    const chromeUp = async (): Promise<boolean> => { try { return await main.evaluate(inMain('return chrome !== undefined && !chrome.isLoading()')) === true } catch { return false } }
    for (let attempt = 0; attempt < 80 && !await chromeUp(); attempt += 1) await sleep(500)
    expect(await chromeUp()).toBe(true)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const listening = await main.evaluate(`(() => { const seam = globalThis.__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true })()`)
      if (listening === true) break
      await sleep(500)
    }
    return { main, close }
  } catch (error) {
    await close()
    throw error
  }
}

/** Serves `sites` from a fixture gateway, launches the shell against it, runs `body`, and tears both down whatever happens. */
export async function withShell (
  sites: Record<string, Record<string, string>>,
  options: { blockDelayMs: number },
  body: (main: Inspector, gateway: Awaited<ReturnType<typeof startFixtureGateway>>) => Promise<void>
): Promise<void> {
  const gateway = await startFixtureGateway(sites, options)
  try {
    const shell = await launchShell(gateway)
    try {
      await body(shell.main, gateway)
    } finally {
      await shell.close()
    }
  } finally {
    await gateway.close()
  }
}

/** Resizes the window twice, the second time larger, as a maximize does. */
export async function resizeOnce (main: Inspector): Promise<void> {
  for (const size of [SMALL, RESIZED]) {
    await main.evaluate(inMain(`win.setBounds(${JSON.stringify(size)}); return true`))
    await sleep(1_000)
  }
  expect(await main.evaluate(inMain('return win.getContentBounds().width'))).toBeGreaterThan(1100)
}

/** Opens a tab on `address` in the window, through the chrome page as a person's own action does. */
export async function openTab (main: Inspector, address: string): Promise<void> {
  await main.evaluate(inMain(`chrome.executeJavaScript(\`window.orivonShell.newTab(${JSON.stringify(address)})\`); return true`))
}

/** Waits until every overlay in `names` is on screen, and returns the overlays that were. */
export async function untilShown (main: Inspector, names: readonly string[], seconds = 30): Promise<string[]> {
  let shown: string[] = []
  for (let attempt = 0; attempt < seconds * 4 && !names.every((name) => shown.includes(name)); attempt += 1) {
    await sleep(250)
    shown = await main.evaluate(SHOWN_OVERLAYS) as string[]
  }
  expect(shown, `${names.join(' and ')} on screen`).toEqual(expect.arrayContaining([...names]))
  return shown
}

/** Opens (or closes) the overlay `name` as a toolbar button does, from a place near the top of the window. */
export async function toggleOverlay (main: Inspector, name: string): Promise<void> {
  const anchor = { x: 600, y: 40, width: 32, height: 32 }
  await main.evaluate(inMain(`chrome.executeJavaScript(\`window.orivonShell.act('overlay.toggle', ${JSON.stringify({ name, anchor })})\`); return true`))
}

/** Starts counting the times the chrome page turns hidden, and for how long it stays so. */
export async function watchChrome (main: Inspector): Promise<void> {
  await main.evaluate(inMain(`return await chrome.executeJavaScript(\`(() => {
    window.__turnedHidden = 0; window.__hiddenMs = 0; let since = null
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { window.__turnedHidden += 1; since = performance.now() }
      else if (since !== null) { window.__hiddenMs += performance.now() - since; since = null }
    })
    window.__hiddenNow = () => window.__hiddenMs + (since === null ? 0 : performance.now() - since)
    return true
  })()\`)`))
}

/** How many times the chrome page turned hidden since `watchChrome`. */
export async function turnedHidden (main: Inspector): Promise<number> {
  return await main.evaluate(inMain(`return await chrome.executeJavaScript('window.__turnedHidden')`)) as number
}

/** How many milliseconds the chrome page has read hidden since `watchChrome`. */
export async function hiddenMilliseconds (main: Inspector): Promise<number> {
  return Math.round(await main.evaluate(inMain(`return await chrome.executeJavaScript('window.__hiddenNow()')`)) as number)
}

export interface ChromeSample { visibility: string, frames: number, overlays: string[] }

/** Reads the chrome four times, 300 ms apart, with the overlays on screen at each reading. */
export async function sampleChrome (main: Inspector): Promise<ChromeSample[]> {
  const samples: ChromeSample[] = []
  for (let i = 0; i < 4; i += 1) {
    const state = await main.evaluate(CHROME_STATE) as { visibility: string, frames: number }
    samples.push({ ...state, overlays: await main.evaluate(SHOWN_OVERLAYS) as string[] })
    await sleep(300)
  }
  return samples
}

/** Each reading of the chrome must be visible with frames drawn, and every overlay in `up` must have been on screen at it. */
export async function expectChromeShown (main: Inspector, up: readonly string[] = []): Promise<ChromeSample[]> {
  const samples = await sampleChrome(main)
  expect(samples.map((sample) => sample.visibility)).toEqual(samples.map(() => 'visible'))
  for (const sample of samples) {
    expect(sample.frames).toBeGreaterThan(5)
    expect(sample.overlays).toEqual(expect.arrayContaining([...up]))
  }
  return samples
}
