// The chrome stays shown, and keeps drawing, when a full-width overlay goes over a window that was resized. The loading
// screen of an `ipfs://` page is such an overlay. After a resize, Chromium counted the chrome view as covered by it: the
// chrome read `hidden`, its animations stopped (the tab strip's loading spinner among them) and only a tab switch, which
// hides the cover, brought it back (src/main/overlays/README.md section An overlay as wide as the window can leave the
// chrome hidden).
//
// Playwright keeps every page it drives visible, so this spec launches the shell with nothing driving the pages and reads
// the chrome through the main process's own inspector, as test/tabs/e2e-undriven-capture.test.ts does. The window is
// resized with setBounds, which is the resize a maximize or a fullscreen makes; under the headless display no window
// manager is needed for it.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const electronPath = createRequire(import.meta.url)('electron') as string
const BLOCK_DELAY_MS = 6_000
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

it('keeps the chrome shown while a full-width overlay is up over a resized window', async () => {
  const gateway = await startFixtureGateway({
    site: { 'index.html': '<!doctype html><meta charset="utf-8"><title>chrome shown fixture</title><body>the page</body>' }
  }, { blockDelayMs: BLOCK_DELAY_MS })
  const dir = await mkdtemp(join(tmpdir(), 'orivon-chrome-shown-'))
  const env = {
    ...process.env, PULSE_SERVER: 'unix:/nonexistent', ORIVON_WINDOW_NO_FOCUS: '1', ORIVON_ETH_LIGHT_CLIENT: 'off', ORIVON_INTRO: 'off',
    ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_DOH: `${gateway.url}/dns-query`
  } as Record<string, string | undefined>
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronPath, ['.', `--user-data-dir=${dir}`, '--inspect=0', '--no-sandbox', '--alsa-output-device=null', HERMETIC_RESOLVER], { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let inspector: Inspector | undefined
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

    for (const size of [SMALL, RESIZED]) {
      await main.evaluate(inMain(`win.setBounds(${JSON.stringify(size)}); return true`))
      await sleep(1_000)
    }
    expect(await main.evaluate(inMain('return win.getContentBounds().width'))).toBeGreaterThan(1100)

    await main.evaluate(inMain(`chrome.executeJavaScript(\`window.orivonShell.newTab('ipfs://${gateway.roots['site']}')\`); return true`))
    let cover = false
    for (let attempt = 0; attempt < 60 && !cover; attempt += 1) {
      await sleep(500)
      cover = await main.evaluate(inMain(`return win.contentView.children.some((v) => v.webContents && v.getVisible() && v.webContents.getURL().includes('overlay=loading-screen'))`)) === true
    }
    expect(cover, 'the loading screen is up').toBe(true)

    // The wrong answer comes within a few frames of the attach and lasts until the cover goes, so a second of settling is enough.
    await sleep(1_000)
    const samples: unknown[] = []
    for (let i = 0; i < 4; i += 1) { samples.push(await main.evaluate(CHROME_STATE)); await sleep(300) }
    expect(samples).toEqual(samples.map(() => expect.objectContaining({ visibility: 'visible' })))
    for (const sample of samples) expect((sample as { frames: number }).frames).toBeGreaterThan(5)
  } finally {
    inspector?.close()
    try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    await sleep(500)
    await rm(dir, { recursive: true, force: true })
    await gateway.close()
  }
}, 180_000)
