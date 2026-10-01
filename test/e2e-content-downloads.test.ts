// A second download a page starts on its own (no click, no key press, an earlier download on the same page load)
// waits for the person: Block cancels it and is remembered, Allow lets it finish and is remembered, and the first
// download of a page and every download the person clicked for are never held. Set ORIVON_UI_SHOTS_DIR to also
// write screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { html, launchShell, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import { delay, popoverShown, waitFor } from './smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const E2E_TIMEOUT_MS = 240_000
const SIZE = 20_000
/** The second file arrives slowly (3 s), so the question is open while it is still on its way. */
const SLOW = SIZE * 20

const autoPage = (prefix: string): string => `<!doctype html><title>auto</title><body><a id="a1" download href="/${prefix}1.bin">1</a><a id="a2" download href="/${prefix}2.bin">2</a>
<script>
document.getElementById('a1').click()
setTimeout(() => document.getElementById('a2').click(), 400)
</script>`
const clickPage = (prefix: string): string => `<!doctype html><title>click</title><body><a id="a1" download href="/${prefix}1.bin">1</a><a id="a2" download href="/${prefix}2.bin">2</a>`

let block: FixtureServer
let allow: FixtureServer
let clicked: FixtureServer
const folders: string[] = []

async function serve (prefix: string): Promise<FixtureServer> {
  return await startServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname
    if (path === `/${prefix}2.bin`) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${prefix}2.bin"`, 'content-length': String(SLOW) })
      let sent = 0
      const send = (): void => {
        if (response.destroyed) return
        response.write(Buffer.alloc(SIZE, 7))
        sent += 1
        if (sent === 20) response.end(); else setTimeout(send, 150)
      }
      send()
    } else if (path.endsWith('.bin')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${path.slice(1)}"`, 'content-length': String(SIZE) })
      response.end(Buffer.alloc(SIZE, 7))
    } else html(response, path === '/click' ? clickPage(prefix) : autoPage(prefix))
  })
}

beforeAll(async () => {
  block = await serve('f')
  allow = await serve('g')
  clicked = await serve('h')
})

afterAll(async () => {
  for (const server of [block, allow, clicked]) await server.close()
  for (const folder of folders) await rm(folder, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const promptPage = (app: App): Page | undefined => app.windows().filter((w) => w.url().includes('overlay=site-prompt') && !w.isClosed()).at(-1)

async function waitPrompt (app: App): Promise<Page> {
  let found: Page | undefined
  const ok = await waitFor(async () => {
    if (!(await popoverShown(app, 'overlay=site-prompt'))) return false
    const candidate = promptPage(app)
    if (candidate === undefined) return false
    try { await candidate.waitForSelector('.site-prompt .btn-row', { timeout: 2_000 }); found = candidate; return true } catch { return false }
  }, 15_000)
  expect(ok).toBe(true)
  return found as Page
}

async function answer (page: Page, label: 'Allow' | 'Block'): Promise<void> {
  await page.waitForSelector('.site-prompt:not(.arming)')
  try { await page.click(`.btn-row .btn:text-is("${label}")`) } catch (error) { if (!/closed|destroyed/.test(String(error))) throw error }
}

const sizeIn = async (folder: string, name: string): Promise<number | undefined> => { try { return (await stat(join(folder, name))).size } catch { return undefined } }

async function chipLabel (chrome: Page): Promise<string> {
  return await chrome.evaluate(() => { const chip = document.querySelector<HTMLButtonElement>('#site-access-chip'); return chip === null || chip.hidden ? '' : chip.getAttribute('aria-label') ?? '' })
}

async function launchWithFolder (): Promise<{ app: App, chrome: Page, folder: string }> {
  const folder = await mkdtemp(join(tmpdir(), 'orivon-auto-downloads-'))
  folders.push(folder)
  return { folder, ...(await launchShell({ seedProfile: async (dir) => { await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'downloads.folder': folder, 'downloads.showBubble': false } })) } })) }
}

async function shoot (app: App, chrome: Page, name: string, prompt: Page): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  await prompt.waitForSelector('.site-prompt:not(.arming)')
  for (const scheme of ['light', 'dark'] as const) {
    await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
    for (const page of [chrome, prompt]) await page.emulateMedia({ colorScheme: scheme })
    await delay(400)
    await prompt.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
    execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-window-${scheme}.png`)])
  }
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system' })
  for (const page of [chrome, prompt]) await page.emulateMedia({ colorScheme: null })
}

it('holds a second download a page starts by itself, and keeps the person\'s answer for the site', async () => {
  const { app, chrome, folder } = await launchWithFolder()
  const sizeOf = async (name: string): Promise<number | undefined> => await sizeIn(folder, name)
  const arrived = async (name: string, size = SIZE): Promise<boolean> => await waitFor(async () => (await sizeOf(name)) === size)
  try {
    // Blocked: the first download arrives, the second waits for the question and is cancelled by Block.
    await visit(app, chrome, `${block.origin}/auto`)
    const prompt = await waitPrompt(app)
    expect(await prompt.locator('.origin').textContent()).toBe(block.origin)
    expect(await prompt.locator('.sp-text').allTextContents()).toEqual(['wants to download several files'])
    expect(await arrived('f1.bin')).toBe(true)
    expect(await sizeOf('f2.bin')).not.toBe(SLOW)
    await shoot(app, chrome, 'ask-downloads', prompt)
    await answer(prompt, 'Block')
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=site-prompt')))).toBe(true)
    await delay(1200)
    expect(await sizeOf('f2.bin')).not.toBe(SLOW)
    expect(await waitFor(async () => (await chipLabel(chrome)) === 'Automatic downloads blocked on this page')).toBe(true)
    const file = join(await app.evaluate(({ app: electron }) => electron.getPath('userData')), 'site-settings.json')
    expect(await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).sites?.[block.origin]?.autoDownloads === 'block')).toBe(true)

    // Remembered: the same page, loaded again, is refused without a question.
    await visit(app, chrome, `${block.origin}/auto?again`)
    await delay(1500)
    expect(await popoverShown(app, 'overlay=site-prompt')).toBe(false)
    expect(await sizeOf('f2.bin')).not.toBe(SLOW)

    // Allowed: the held download finishes, and the answer is stored.
    await visit(app, chrome, `${allow.origin}/auto`)
    const second = await waitPrompt(app)
    expect(await arrived('g1.bin')).toBe(true)
    expect(await sizeOf('g2.bin')).not.toBe(SLOW)
    await answer(second, 'Allow')
    expect(await arrived('g2.bin', SLOW)).toBe(true)
    expect(await waitFor(() => JSON.parse(readFileSync(file, 'utf8')).sites?.[allow.origin]?.autoDownloads === 'allow')).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('never holds a download the person clicked for', async () => {
  const { app, chrome, folder } = await launchWithFolder()
  const sizeOf = async (name: string): Promise<number | undefined> => await sizeIn(folder, name)
  const arrived = async (name: string, size = SIZE): Promise<boolean> => await waitFor(async () => (await sizeOf(name)) === size)
  try {
    const view = await visit(app, chrome, `${clicked.origin}/click`)
    await view.click('#a1')
    await view.click('#a2')
    expect(await arrived('h1.bin')).toBe(true)
    expect(await arrived('h2.bin', SLOW)).toBe(true)
    await delay(800)
    expect(await popoverShown(app, 'overlay=site-prompt')).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
