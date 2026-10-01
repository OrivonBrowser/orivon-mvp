// Packet 4 lanes together in one window: groups, a sleeping and a pinned tab, the side panel, the reader tab
// and the F6 order, a restart that brings the tabs back asleep, and the new Settings sections. Set
// ORIVON_UI_SHOTS_DIR to write whole-window screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { launchShell } from './qa-helpers.js'
import { delay, popoverShown, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'

const SHOTS = process.env['ORIVON_UI_SHOTS_DIR']
const TEST_TIMEOUT_MS = 240_000
let server: Server
let origin = ''

const PARAGRAPH = 'The quick brown fox jumps over the lazy dog while the afternoon light moves slowly across the quiet valley, and everyone who passes the old mill stops to listen to the water.'
const article = (): string => `<!doctype html><html lang="en"><head><title>A Long Walk Home</title></head><body><article><h1>A Long Walk Home</h1>${Array.from({ length: 6 }, () => `<p>${PARAGRAPH}</p>`).join('')}</article></body></html>`

const CONTINUE = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'startup.mode': 'continue' } }))
}

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(request.url === '/article' ? article() : `<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true })
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

// A page under the test driver counts as captured, which keeps it awake: the seam the memory-saver spec uses.
const ignoreCapture = async (app: ElectronApplication): Promise<void> => {
  await app.evaluate(() => { (globalThis as unknown as { __orivonSleepIgnoreCapture: boolean }).__orivonSleepIgnoreCapture = true })
}
const runCommand = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}
const activate = async (chrome: Page, id: string): Promise<void> => { await chrome.click(`.tab[data-id="${id}"]`) }
async function groupFront (app: ElectronApplication, chrome: Page): Promise<void> {
  await runCommand(chrome, 'tab.group')
  expect(await waitFor(async () => await popoverShown(app, 'overlay=tab-group'))).toBe(true)
  expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=tab-group')))).toBe(true)
  const bubble = app.windows().find((w) => w.url().includes('overlay=tab-group'))
  await bubble?.waitForSelector('.tg-name')
  await bubble?.focus('.tg-name')
  await bubble?.keyboard.press('Enter').catch(() => {})
  expect(await waitFor(async () => !(await popoverShown(app, 'overlay=tab-group')))).toBe(true)
}
const tabEl = (chrome: Page, id: string) => chrome.locator(`.tab[data-id="${id}"]`)
const classesOf = async (chrome: Page, id: string): Promise<string[]> => ((await tabEl(chrome, id).getAttribute('class')) ?? '').split(' ')

async function openTabs (chrome: Page, ...paths: string[]): Promise<string[]> {
  for (const path of paths) {
    await chrome.click('#new-tab')
    await clickAddressBarRetrying(chrome, `${origin}${path}`)
    expect((await waitForTab(chrome, { address: `${origin}${path}` })).ok).toBe(true)
  }
  return await tabIds(chrome) as string[]
}

async function resizeTo (app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BaseWindow }, [w, h]) => { BaseWindow.getAllWindows()[0]?.setSize(w as number, h as number) }, [width, height])
  await delay(500)
}

async function shootWindow (app: ElectronApplication, chrome: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  await chrome.mouse.move(700, 14)
  const box = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getBounds() ?? null)
  for (const theme of ['light', 'dark'] as const) {
    for (const page of app.windows()) await page.emulateMedia({ colorScheme: theme }).catch(() => {})
    await delay(700)
    const crop = box === null ? [] : ['-crop', `${String(box.width)}x${String(box.height)}+${String(Math.max(0, box.x))}+${String(Math.max(0, box.y))}`, '+repage']
    try { execFileSync('import', ['-window', 'root', ...crop, join(SHOTS, `${name}-${theme}.png`)]) } catch { /* no ImageMagick */ }
  }
  for (const page of app.windows()) await page.emulateMedia({ colorScheme: null }).catch(() => {})
}

const pressFocused = async (app: ElectronApplication, keyCode: string, modifiers: Array<'shift'> = []): Promise<void> => {
  await app.evaluate(({ webContents }, [code, held]) => {
    const target = webContents.getFocusedWebContents() ?? webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/renderer/index.html'))
    for (const type of ['keyDown', 'keyUp'] as const) target?.sendInputEvent({ type, keyCode: code as string, modifiers: held as Array<'shift'> })
  }, [keyCode, modifiers])
}

const focusedUrl = async (app: ElectronApplication): Promise<string> =>
  await app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '')

it('keeps groups, sleep, the side panel, the reader and the F6 order working together', async () => {
  const { app, chrome } = await launchShell({ seedProfile: CONTINUE })
  let dir = ''
  try {
    await ignoreCapture(app)
    await resizeTo(app, 1280, 800)
    const ids = await openTabs(chrome, '/article', '/b', '/c', '/d', '/e')
    const [, article, b, c, d, e] = ids as [string, string, string, string, string, string]
    dir = await app.evaluate(({ app: electron }) => electron.getPath('userData'))

    await activate(chrome, d)
    await runCommand(chrome, 'tab.pin')
    await activate(chrome, article)
    await groupFront(app, chrome)
    await activate(chrome, b)
    await groupFront(app, chrome)
    await activate(chrome, e)
    await runCommand(chrome, 'tab.sleep')
    const slept = await waitFor(async () => (await classesOf(chrome, e)).includes('sleeping'))
    if (!slept) {
      const toast = app.windows().find((w) => w.url().includes('overlay=toast'))
      console.error('[b4] sleep refused', JSON.stringify({ active: await chrome.locator('.tab.active').getAttribute('data-id'), e, classes: await classesOf(chrome, e), toast: toast === undefined ? null : await toast.locator('.toast').innerText().catch(() => null) }))
    }
    expect(slept).toBe(true)
    await activate(chrome, article)
    expect(await waitFor(async () => await chrome.locator('#reader').isVisible())).toBe(true)
    await shootWindow(app, chrome, 'strip-groups-sleeping')

    // The side panel next to the groups and the sleeping tab.
    await runCommand(chrome, 'sidePanel.toggle')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=side-panel'))).toBe(true)
    await delay(500)
    await shootWindow(app, chrome, 'side-panel-open')

    // F6 walks the chrome, then the side panel, then the page.
    const seen: string[] = []
    for (let step = 0; step < 8; step += 1) {
      await pressFocused(app, 'F6')
      await delay(400)
      seen.push(await focusedUrl(app))
      if ((await focusedUrl(app)).includes('overlay=side-panel')) { await shootWindow(app, chrome, 'f6-side-panel'); break }
    }
    expect(seen.some((url) => url.includes('overlay=side-panel')), seen.join(' | ')).toBe(true)

    // On from the panel to the page, and back: Shift+F6 from the page lands in the panel, and the next one in the chrome's last pane.
    await pressFocused(app, 'F6')
    expect(await waitFor(async () => (await focusedUrl(app)).startsWith(origin)), await focusedUrl(app)).toBe(true)
    await pressFocused(app, 'F6', ['shift'])
    expect(await waitFor(async () => (await focusedUrl(app)).includes('overlay=side-panel')), await focusedUrl(app)).toBe(true)
    await pressFocused(app, 'F6', ['shift'])
    expect(await waitFor(async () => await chrome.evaluate(() => document.activeElement?.classList.contains('tab') === true))).toBe(true)
    expect(await focusedUrl(app)).toContain('/renderer/index.html')

    // The reader tab opens inside the article's group.
    await activate(chrome, article)
    await runCommand(chrome, 'page.reader')
    expect(await waitFor(async () => (await tabIds(chrome) as string[]).length === ids.length + 1)).toBe(true)
    const after = await tabIds(chrome) as string[]
    const reader = after[after.indexOf(article) + 1] as string
    const articleGroup = await tabEl(chrome, article).getAttribute('data-group')
    expect(articleGroup).not.toBeNull()
    expect(await tabEl(chrome, reader).getAttribute('data-group')).toBe(articleGroup)
    await delay(800)
    await shootWindow(app, chrome, 'reader-in-group')
    await runCommand(chrome, 'page.reader')

    // Narrow: the side panel gives way.
    await resizeTo(app, 700, 800)
    await shootWindow(app, chrome, 'narrow-700')
    await resizeTo(app, 1280, 800)
    expect(await waitFor(async () => (await classesOf(chrome, c)).length > 0)).toBe(true)

    // Settings sections the lanes added.
    for (const section of ['accessibility', 'performance', 'content', 'appearance', 'tabs']) {
      await chrome.evaluate((at) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', at) }, `/${section}`)
      expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings') && w.url().endsWith(section)))).toBe(true)
      await delay(700)
      await shootWindow(app, chrome, `settings-${section}`)
    }
    expect(dir).not.toBe('')
  } finally {
    await closeElectron(app, { keepProfile: true })
  }
  const again = await launchShell({ reuseProfile: dir })
  try {
    await ignoreCapture(again.app)
    // Pinned and in-front tabs stay awake; the rest of the restored tabs start asleep.
    expect(await waitFor(async () => await again.chrome.locator('.tab.sleeping').count() >= 2)).toBe(true)
    expect(await again.chrome.locator('.tab.active.sleeping').count()).toBe(0)
    expect(await again.chrome.locator('.tab.pinned.sleeping').count()).toBe(0)
    await shootWindow(again.app, again.chrome, 'restored-asleep')
  } finally {
    await closeElectron(again.app)
  }
}, TEST_TIMEOUT_MS * 2)
