// Tab groups in the running shell: a group made from a tab, named and coloured in its bubble, joined from the
// tab menu, collapsed to its chip, moved into and out of with the keys, left by pinning, closed by two clicks, kept
// across a restart, and written nowhere by a private window. Set ORIVON_TAB_GROUPS_SHOTS to write screenshots of
// each surface in both themes.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, findViewShowing, popoverShown, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

let server: Server
let origin = ''
const SHOTS = process.env['ORIVON_TAB_GROUPS_SHOTS']
const TEST_TIMEOUT_MS = 120_000
const CONTINUE = async (dir: string): Promise<void> => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'startup.mode': 'continue' } }))
}

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p><button id="open" onclick="window.open('/linked', '_blank')">open</button>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true })
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openTabs (chrome: Page, ...paths: string[]): Promise<string[]> {
  for (const path of paths) {
    await chrome.click('#new-tab')
    await clickAddressBarRetrying(chrome, `${origin}${path}`)
    expect((await waitForTab(chrome, { address: `${origin}${path}` })).ok).toBe(true)
  }
  return await tabIds(chrome) as string[]
}

const runCommand = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}
const activate = async (chrome: Page, id: string): Promise<void> => { await chrome.click(`.tab[data-id="${id}"]`) }
const order = async (chrome: Page): Promise<string[]> => await tabIds(chrome) as string[]
const groupOfTab = async (chrome: Page, id: string): Promise<string | null> => await chrome.locator(`.tab[data-id="${id}"]`).getAttribute('data-group')
const hiddenTabs = async (chrome: Page): Promise<number> => await chrome.locator('.tab[hidden]').count()
const chips = (chrome: Page) => chrome.locator('.tab-group-chip')
const activeId = async (chrome: Page): Promise<string | null> => await chrome.locator('.tab.active').getAttribute('data-id')

const bubbleOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('overlay=tab-group'))
async function bubble (app: ElectronApplication): Promise<Page> {
  expect(await waitFor(async () => await popoverShown(app, 'overlay=tab-group'))).toBe(true)
  expect(await waitFor(() => bubbleOf(app) !== undefined)).toBe(true)
  const page = bubbleOf(app) as Page
  await page.waitForSelector('.tg-name')
  await page.waitForSelector('.tg-swatch')
  return page
}
const bubbleClosed = async (app: ElectronApplication): Promise<boolean> => await waitFor(async () => !(await popoverShown(app, 'overlay=tab-group')))

/** Replaces the native tab menu with one that records itself, so a test can read and pick its items. */
async function stubTabMenu (app: ElectronApplication): Promise<{ labels: () => Promise<string[]>, choose: (label: string, inside?: string) => Promise<void> }> {
  await app.evaluate(({ Menu }) => { (Menu.prototype as unknown as { popup: () => void }).popup = function (this: unknown) { (globalThis as unknown as { __menu: unknown }).__menu = this } })
  return {
    labels: async () => await app.evaluate(() => ((globalThis as unknown as { __menu?: { items: Array<{ label: string, type: string }> } }).__menu?.items ?? []).filter((item) => item.type !== 'separator').map((item) => item.label)),
    choose: async (label, inside) => {
      await app.evaluate((_, [l, parent]) => {
        type Item = { label: string, click: () => void, submenu?: { items: Item[] } }
        const top = ((globalThis as unknown as { __menu: { items: Item[] } }).__menu.items)
        const items = parent === undefined ? top : top.find((item) => item.label === parent)?.submenu?.items ?? []
        items.find((item) => item.label === l)?.click()
      }, [label, inside])
    }
  }
}

async function shootChrome (chrome: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  for (const theme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: theme })
    await chrome.mouse.move(700, 60)
    await waitFor(async () => await chrome.evaluate((t) => matchMedia('(prefers-color-scheme: dark)').matches === (t === 'dark'), theme))
    await chrome.waitForTimeout(250)
    await chrome.screenshot({ path: join(SHOTS, `${name}-${theme}.png`), clip: { x: 0, y: 0, width: 1280, height: 76 } })
  }
  await chrome.emulateMedia({ colorScheme: null })
}

async function shootBubble (page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

async function sessionOf (dir: string): Promise<{ windows: Array<{ groups?: Array<{ title: string, color: string, collapsed: boolean }>, tabs: Array<{ url: string, group?: number }> }> } | null> {
  try { return JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) } catch { return null }
}
const userDataOf = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))

it('makes a group from a tab, names and colours it, adds a tab from the tab menu, collapses and expands it', async () => {
  const { app, chrome } = await launchShell({ seedProfile: CONTINUE })
  try {
    const menu = await stubTabMenu(app)
    const [first, a, b, c] = await openTabs(chrome, '/a', '/b', '/c') as [string, string, string, string]
    await activate(chrome, a)
    await runCommand(chrome, 'tab.group')
    expect(await waitFor(async () => await chips(chrome).count() === 1)).toBe(true)
    expect(await groupOfTab(chrome, a)).not.toBeNull()

    // The bubble opens at once, with the name field ready.
    const page = await bubble(app)
    expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('tg-name')
    expect(await page.locator('.tg-swatch').count()).toBe(8)
    expect(await page.locator('.tg-swatch[aria-checked="true"]').getAttribute('aria-label')).toBe('Gray')
    expect(await page.locator('.tg-actions [role="menuitem"]').allTextContents()).toEqual(['New tab in group', 'Ungroup', 'Move group to new window', 'Close group'])
    // The bubble shows all of its content: it is shorter than its 320 px cap, so its own scroll box does not scroll.
    const fit = await page.evaluate(() => {
      const scroller = document.getElementById('scroll') as HTMLElement
      return { content: Math.ceil((document.getElementById('content') as HTMLElement).getBoundingClientRect().height), scrolls: scroller.scrollHeight > scroller.clientHeight }
    })
    expect(fit.content).toBeLessThan(320)
    expect(fit.scrolls).toBe(false)
    await shootBubble(page, 'bubble-empty')
    await shootChrome(chrome, 'strip-untitled')

    await page.keyboard.type('Work')
    await page.click('.tg-swatch[data-color="green"]')
    await shootBubble(page, 'bubble-named')
    expect(await waitFor(async () => await chips(chrome).locator('.tg-title').textContent() === 'Work')).toBe(true)
    expect(await chips(chrome).getAttribute('data-color')).toBe('green')
    expect(await chips(chrome).getAttribute('aria-label')).toBe('Work, group of 1 tab, expanded')
    await page.focus('.tg-name')
    await page.keyboard.press('Enter').catch(() => {})
    expect(await bubbleClosed(app)).toBe(true)
    await shootChrome(chrome, 'strip-one-group')

    // The tab menu lists the group to join, and a member can be taken out.
    await chrome.click(`.tab[data-id="${b}"]`, { button: 'right' })
    expect(await waitFor(async () => (await menu.labels()).includes('Add Tab to Group'))).toBe(true)
    expect(await menu.labels()).toContain('Add Tab to New Group')
    expect(await menu.labels()).not.toContain('Remove from Group')
    await menu.choose('Work', 'Add Tab to Group')
    expect(await waitFor(async () => await groupOfTab(chrome, b) !== null)).toBe(true)
    expect(await order(chrome)).toEqual([first, a, b, c])
    expect(await chips(chrome).getAttribute('aria-label')).toBe('Work, group of 2 tabs, expanded')
    await chrome.click(`.tab[data-id="${b}"]`, { button: 'right' })
    expect(await waitFor(async () => (await menu.labels()).includes('Remove from Group'))).toBe(true)

    // Collapsing hides the tabs and moves the tab in front out of the group.
    await activate(chrome, a)
    await chips(chrome).click()
    expect(await waitFor(async () => await hiddenTabs(chrome) === 2)).toBe(true)
    expect(await chips(chrome).locator('.tg-count').textContent()).toBe('2')
    expect(await chips(chrome).getAttribute('aria-expanded')).toBe('false')
    expect(await groupOfTab(chrome, (await activeId(chrome)) ?? '')).toBeNull()
    await shootChrome(chrome, 'strip-collapsed')

    await chips(chrome).click()
    expect(await waitFor(async () => await hiddenTabs(chrome) === 0)).toBe(true)

    // A page opened from a member opens inside the group; the command takes it out again.
    await activate(chrome, a)
    const before = await order(chrome)
    const view = findViewShowing(app, chrome, `${origin}/a`) as Page
    await view.click('#open')
    expect(await waitFor(async () => (await order(chrome)).length === before.length + 1)).toBe(true)
    const linked = (await order(chrome)).find((id) => !before.includes(id)) ?? ''
    expect(await groupOfTab(chrome, linked)).toBe(await groupOfTab(chrome, a))
    await runCommand(chrome, 'tab.ungroup')
    expect(await waitFor(async () => await groupOfTab(chrome, linked) === null)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('moves a tab into a group and out with the keys, takes a pinned tab out, and closes the group with two clicks', async () => {
  const { app, chrome } = await launchShell({ seedProfile: CONTINUE })
  try {
    const [first, a, b, c] = await openTabs(chrome, '/a', '/b', '/c') as [string, string, string, string]
    // [first a b c]: make a and b a group by the menu route, then walk c left through it.
    await activate(chrome, a)
    await runCommand(chrome, 'tab.group')
    await bubble(app)
    await (bubbleOf(app) as Page).keyboard.press('Escape').catch(() => {})
    const menu = await stubTabMenu(app)
    await chrome.click(`.tab[data-id="${b}"]`, { button: 'right' })
    await waitFor(async () => (await menu.labels()).includes('Add Tab to Group'))
    await menu.choose('Untitled Group (Gray)', 'Add Tab to Group')
    expect(await waitFor(async () => await groupOfTab(chrome, b) !== null)).toBe(true)

    await activate(chrome, c)
    await runCommand(chrome, 'tab.moveLeft')
    expect(await waitFor(async () => (await order(chrome)).join() === [first, a, c, b].join())).toBe(true)
    expect(await groupOfTab(chrome, c)).toBe(await groupOfTab(chrome, a))
    await runCommand(chrome, 'tab.moveLeft')
    expect(await waitFor(async () => (await order(chrome)).join() === [first, c, a, b].join())).toBe(true)
    expect(await groupOfTab(chrome, c)).not.toBeNull()
    await runCommand(chrome, 'tab.moveLeft')
    expect(await waitFor(async () => (await order(chrome)).join() === [c, first, a, b].join())).toBe(true)
    expect(await groupOfTab(chrome, c)).toBeNull()
    expect(await groupOfTab(chrome, a)).not.toBeNull()

    // Pinning a member takes it out of the group.
    await activate(chrome, b)
    await runCommand(chrome, 'tab.pin')
    expect(await waitFor(async () => await chrome.locator('.tab.pinned').count() === 1)).toBe(true)
    expect(await groupOfTab(chrome, b)).toBeNull()
    expect(await chips(chrome).getAttribute('aria-label')).toBe('Untitled group of 1 tab, expanded')

    // Two clicks close the group's tabs.
    await chips(chrome).click({ button: 'right' })
    const page = await bubble(app)
    const close = page.locator('.tg-danger')
    expect(await close.locator('.item-title').textContent()).toBe('Close group')
    await close.click()
    expect(await close.locator('.item-title').textContent()).toBe('Click again to close 1 tab')
    await shootBubble(page, 'bubble-armed')
    await close.click()
    expect(await waitFor(async () => !(await order(chrome)).includes(a))).toBe(true)
    expect(await chips(chrome).count()).toBe(0)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps a group in the session file and brings it back with its name, colour and collapsed state', async () => {
  const first = await launchShell({ seedProfile: CONTINUE })
  let dir = ''
  try {
    const [, a, b] = await openTabs(first.chrome, '/a', '/b', '/c') as [string, string, string, string]
    dir = await userDataOf(first.app)
    await activate(first.chrome, a)
    await runCommand(first.chrome, 'tab.group')
    const page = await bubble(first.app)
    await page.keyboard.type('Reading')
    await page.click('.tg-swatch[data-color="purple"]')
    await page.focus('.tg-name')
    await page.keyboard.press('Enter').catch(() => {})
    expect(await bubbleClosed(first.app)).toBe(true)
    const menu = await stubTabMenu(first.app)
    await first.chrome.click(`.tab[data-id="${b}"]`, { button: 'right' })
    await waitFor(async () => (await menu.labels()).includes('Add Tab to Group'))
    await menu.choose('Reading', 'Add Tab to Group')
    expect(await waitFor(async () => await groupOfTab(first.chrome, b) !== null)).toBe(true)
    await chips(first.chrome).click()
    expect(await waitFor(async () => await hiddenTabs(first.chrome) === 2)).toBe(true)
    // The recorder writes after a pause: wait for the group to reach the file.
    expect(await waitFor(async () => (await sessionOf(dir))?.windows[0]?.groups?.[0]?.collapsed === true)).toBe(true)
    const written = await sessionOf(dir)
    expect(written?.windows[0]?.groups).toEqual([{ title: 'Reading', color: 'purple', collapsed: true }])
    expect(written?.windows[0]?.tabs.map((tab) => tab.group)).toEqual([0, 0, undefined])
  } finally {
    await closeElectron(first.app, { keepProfile: true })
  }
  const again = await launchShell({ reuseProfile: dir })
  try {
    expect(await waitFor(async () => await chips(again.chrome).count() === 1)).toBe(true)
    expect(await chips(again.chrome).locator('.tg-title').textContent()).toBe('Reading')
    expect(await chips(again.chrome).getAttribute('data-color')).toBe('purple')
    expect(await chips(again.chrome).getAttribute('aria-expanded')).toBe('false')
    expect(await hiddenTabs(again.chrome)).toBe(2)
    expect(await order(again.chrome)).toHaveLength(3)
  } finally {
    await closeElectron(again.app)
  }
}, TEST_TIMEOUT_MS * 2)

it('keeps every tab group out of the file in a private window', async () => {
  const { app, chrome } = await launchShell({ args: ['--orivon-private'], seedProfile: CONTINUE })
  try {
    const dir = await userDataOf(app)
    const [, a] = await openTabs(chrome, '/a') as [string, string]
    await activate(chrome, a)
    await runCommand(chrome, 'tab.group')
    expect(await waitFor(async () => await chips(chrome).count() === 1)).toBe(true)
    await bubble(app)
    await (bubbleOf(app) as Page).keyboard.type('Secret')
    await delay(ABSENCE_SETTLE_MS * 3)
    await access(join(dir, 'session.json')).then(() => { throw new Error('a private window wrote session.json') }, () => undefined)
    await shootChrome(chrome, 'strip-private')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('draws every colour, an untitled and a collapsed group, and a strip of forty tabs with five groups', async () => {
  const { app, chrome } = await launchShell({ seedProfile: CONTINUE })
  try {
    const colours = ['gray', 'blue', 'red', 'orange', 'green', 'pink', 'purple', 'teal']
    const paths = colours.map((_, n) => `/c${String(n)}`)
    const ids = (await openTabs(chrome, ...paths)).slice(1)
    for (const [n, id] of ids.entries()) {
      await activate(chrome, id)
      await runCommand(chrome, 'tab.group')
      expect(await waitFor(async () => await chips(chrome).count() === n + 1)).toBe(true)
      const page = await bubble(app)
      await page.click(`.tg-swatch[data-color="${colours[n] ?? 'gray'}"]`)
      if (n % 2 === 0) { await page.focus('.tg-name'); await page.keyboard.type(`G${String(n)}`) }
      await page.keyboard.press('Escape').catch(() => {})
      expect(await bubbleClosed(app)).toBe(true)
    }
    expect(await chips(chrome).evaluateAll((els) => els.map((el) => el.getAttribute('data-color')))).toEqual(colours)
    await activate(chrome, ids[0] ?? '')
    await shootChrome(chrome, 'strip-all-colours')
    await chips(chrome).nth(3).click()
    expect(await waitFor(async () => await hiddenTabs(chrome) === 1)).toBe(true)
    await chips(chrome).nth(6).click()
    await shootChrome(chrome, 'strip-collapsed-mixed')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS * 2)

it('keeps chips legible and tabs at their minimum width in a strip of forty tabs', async () => {
  const { app, chrome } = await launchShell({ seedProfile: CONTINUE })
  try {
    for (let n = 0; n < 39; n += 1) await chrome.evaluate((address) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(address) }, `${origin}/t${String(n)}`)
    expect(await waitFor(async () => (await order(chrome)).length === 40)).toBe(true)
    const ids = await order(chrome)
    for (const [n, start] of [2, 10, 18, 26, 34].entries()) {
      await activate(chrome, ids[start] ?? '')
      await runCommand(chrome, 'tab.group')
      expect(await waitFor(async () => await chips(chrome).count() === n + 1)).toBe(true)
      const page = await bubble(app)
      await page.click(`.tg-swatch[data-color="${['blue', 'green', 'orange', 'pink', 'teal'][n] ?? 'gray'}"]`)
      await page.focus('.tg-name')
      await page.keyboard.type(['Work', 'Shopping', 'Reading', 'Research', 'Trips'][n] ?? '')
      await page.keyboard.press('Escape').catch(() => {})
      expect(await bubbleClosed(app)).toBe(true)
    }
    await activate(chrome, ids[2] ?? '')
    const sizes = await chrome.evaluate(() => ({
      chips: [...document.querySelectorAll<HTMLElement>('.tab-group-chip')].map((el) => ({ text: el.textContent, fits: el.scrollWidth <= el.clientWidth + 1 })),
      tabs: Math.min(...[...document.querySelectorAll<HTMLElement>('.tab')].map((el) => el.getBoundingClientRect().width))
    }))
    expect(sizes.chips.every((chip) => chip.fits)).toBe(true)
    expect(sizes.tabs).toBeGreaterThanOrEqual(43.5)
    await shootChrome(chrome, 'strip-forty-tabs')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS * 3)
