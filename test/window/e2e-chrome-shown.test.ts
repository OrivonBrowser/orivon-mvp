// The chrome stays shown, and keeps drawing, when an opaque overlay as wide as the page area is up over it. The loading
// screen of an `ipfs://` page is such an overlay. After a resize, Chromium counted the chrome view as covered by it: the
// chrome read `hidden`, its animations stopped (the tab strip's loading spinner among them) and only a tab switch, which
// hides the cover, brought it back. A question over the loading screen (the first visit to an app asks while its page
// still loads) left the chrome hidden in a window never resized too, and the repair left it so when it showed the panel
// again after the cover (src/main/overlays/README.md section An overlay as wide as the window can leave the chrome hidden).
//
// Playwright keeps every page it drives visible, so this spec launches the shell with nothing driving the pages and reads
// the chrome through the main process's own inspector, as test/tabs/e2e-undriven-capture.test.ts does. The window is
// resized with setBounds, which is the resize a maximize or a fullscreen makes; under the headless display no window
// manager is needed for it.
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { withDeclaredTree } from '../web3/first-visit-support.js'

const electronPath = createRequire(import.meta.url)('electron') as string
const BLOCK_DELAY_MS = 6_000
/** Each block of the app's site is answered this late, so the question comes a few seconds in and the page a dozen seconds in. */
const QUESTION_BLOCK_DELAY_MS = 1_000
/** Both fit the 1280 by 1024 display the headless runner gives; the second is larger than the window's first size. */
const SMALL = { x: 0, y: 0, width: 700, height: 500 }
const RESIZED = { x: 0, y: 0, width: 1200, height: 900 }

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Inspector { evaluate: (expression: string) => Promise<unknown>, close: () => void }

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

const sleep = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }

/** Runs `body` in the main process with `chrome` the chrome page's webContents and `win` the window. */
const inMain = (body: string): string => `(async () => {
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

interface Shell { main: Inspector, close: () => Promise<void> }

/** The shell on a throwaway profile with an inspector on its main process and nothing on its pages, its names and `ipfs://` sites served by `gateway`. */
async function launchShell (gateway: { url: string }): Promise<Shell> {
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

/** Resizes the window twice, the second time larger, as a maximize does. */
async function resizeOnce (main: Inspector): Promise<void> {
  for (const size of [SMALL, RESIZED]) {
    await main.evaluate(inMain(`win.setBounds(${JSON.stringify(size)}); return true`))
    await sleep(1_000)
  }
  expect(await main.evaluate(inMain('return win.getContentBounds().width'))).toBeGreaterThan(1100)
}

/** The overlays on screen, by the name in their page's address. */
const SHOWN_OVERLAYS = inMain(`return win.contentView.children.filter((v) => v.webContents && v.getVisible()).map((v) => /overlay=([a-z-]+)/.exec(v.webContents.getURL())?.[1]).filter((name) => name !== undefined)`)

/** Samples the chrome four times, 300 ms apart: each must read visible and have drawn frames. */
async function expectChromeShown (main: Inspector): Promise<void> {
  const samples: unknown[] = []
  for (let i = 0; i < 4; i += 1) { samples.push(await main.evaluate(CHROME_STATE)); await sleep(300) }
  expect(samples).toEqual(samples.map(() => expect.objectContaining({ visibility: 'visible' })))
  for (const sample of samples) expect((sample as { frames: number }).frames).toBeGreaterThan(5)
}

/** Serves `sites` from a fixture gateway, launches the shell against it, runs `body`, and tears both down whatever happens. */
async function withShell (sites: Record<string, Record<string, string>>, options: { blockDelayMs: number }, body: (main: Inspector, roots: Record<string, string>) => Promise<void>): Promise<void> {
  const gateway = await startFixtureGateway(sites, options)
  try {
    const shell = await launchShell(gateway)
    try {
      await body(shell.main, gateway.roots as Record<string, string>)
    } finally {
      await shell.close()
    }
  } finally {
    await gateway.close()
  }
}

it('keeps the chrome shown while a full-width overlay is up over a resized window', async () => {
  const site = { 'index.html': '<!doctype html><meta charset="utf-8"><title>chrome shown fixture</title><body>the page</body>' }
  await withShell({ site }, { blockDelayMs: BLOCK_DELAY_MS }, async (main, roots) => {
    await resizeOnce(main)

    await main.evaluate(inMain(`chrome.executeJavaScript(\`window.orivonShell.newTab('ipfs://${roots['site']}')\`); return true`))
    let cover = false
    for (let attempt = 0; attempt < 60 && !cover; attempt += 1) {
      await sleep(500)
      cover = (await main.evaluate(SHOWN_OVERLAYS) as string[]).includes('loading-screen')
    }
    expect(cover, 'the loading screen is up').toBe(true)

    // The wrong answer comes within a few frames of the attach and lasts until the cover goes, so a second of settling is enough.
    await sleep(1_000)
    await expectChromeShown(main)
  })
}, 180_000)

/** An app that asks for a grant, so its first visit puts a question over the loading screen, and whose page keeps loading for a dozen block delays after it: each script writes the next one into the document, so the page is not ready until the last. */
const SLOW_APP_SCRIPTS = 12
const slowApp = (): Record<string, string> => ({
  'index.html': '<!doctype html><meta charset="utf-8"><title>Slow app</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>Slow app<script src="s0.js"></script></body>',
  ...Object.fromEntries(Array.from({ length: SLOW_APP_SCRIPTS }, (_, n) => [`s${String(n)}.js`, n === SLOW_APP_SCRIPTS - 1 ? '/* last */' : `document.write('<script src="s${String(n + 1)}.js"></scr' + 'ipt>')`])),
  '.well-known/orivon.json': JSON.stringify({
    orivonApiVersion: 0, id: 'chrome.shown.slow.app', name: 'Slow app', version: '1.0.0', entry: 'index.html',
    assets: Array.from({ length: SLOW_APP_SCRIPTS }, (_, n) => `s${String(n)}.js`), capabilities: { trust: { score: true } }
  })
})

it.each([['a window never resized', false], ['a resized window', true]])('keeps the chrome shown while the first visit to an app asks its question over the loading screen, in %s', async (_name, resize) => {
  const sites = { slowApp: await withDeclaredTree(slowApp()) }
  await withShell(sites, { blockDelayMs: QUESTION_BLOCK_DELAY_MS }, async (main, roots) => {
    if (resize) await resizeOnce(main)

    await main.evaluate(inMain(`chrome.executeJavaScript(\`window.orivonShell.newTab('ipfs://${roots['slowApp']}')\`); return true`))
    let overlays: string[] = []
    for (let attempt = 0; attempt < 120 && !overlays.includes('question'); attempt += 1) {
      await sleep(250)
      overlays = await main.evaluate(SHOWN_OVERLAYS) as string[]
    }
    expect(overlays, 'the question is up').toContain('question')
    expect(overlays, 'the loading screen is still up under it').toContain('loading-screen')

    // The repair settles within a few frames; the cover stays until the page's last script has been read.
    await sleep(500)
    await expectChromeShown(main)
    expect(await main.evaluate(SHOWN_OVERLAYS), 'the question and the loading screen were both up throughout').toEqual(expect.arrayContaining(['question', 'loading-screen']))
  })
}, 180_000)
