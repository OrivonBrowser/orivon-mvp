// The main menu is kept warm (an overlay with `keep: 'warm'`): once built,
// its WebContentsView is reused on every open rather than destroyed and
// rebuilt. It is NOT built at window construction -- every window would
// otherwise carry a hidden renderer process nobody may ever open (this is
// what `npm run smoke`'s own two-window count at launch, and every e2e
// launch, would catch). Instead the toolbar button's own hover or focus
// (renderer/main.ts) asks main to build it ahead of the click that usually
// follows; a click with no prior hover (keyboard, a direct programmatic
// click) still builds it, just not ahead of time. A fresh view (any other
// tab or popup) still needs its own pre-paint background colour set before
// it is ever attached -- checked here for a brand-new tab via the e2e-only
// view-background-test-hook.ts.
import { expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from './launch-electron.mjs'
import { pressKey } from './e2e-helpers.js'
import { distinctColours } from './qa-visual.js'
import { ABSENCE_SETTLE_MS, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from './smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 45_000

/** No launch here ever plays audio, but PulseAudio/ALSA still exist under
 * xvfb, on the owner's real sound hardware -- silenced regardless. */
const SILENT = {
  env: { PULSE_SERVER: 'unix:/nonexistent' },
  args: [HERMETIC_RESOLVER, '--alsa-output-device=null']
}

function menuWebContentsId (app: Awaited<ReturnType<typeof launchElectron>>): Promise<number | undefined> {
  return app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().find((wc) => wc.getURL().includes('overlay=menu'))?.id)
}

/**
 * The chrome page, once its own script has run. That script attaches the
 * menu button's listeners, and the page exists before it has: a click or a
 * hover that lands in between is lost, and the menu never opens. A module
 * script with no top-level await has run by the time the document is
 * `complete`.
 */
async function readyChrome (app: Awaited<ReturnType<typeof launchElectron>>): Promise<ReturnType<typeof findChrome>> {
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  await chrome.waitForFunction(() => document.readyState === 'complete')
  return chrome
}

function menuPage (app: Awaited<ReturnType<typeof launchElectron>>): ReturnType<typeof app.windows>[number] | undefined {
  return app.windows().find((w) => w.url().includes('overlay=menu'))
}

it('builds no menu view at launch, builds one on the button\'s own hover, and reuses it on every open', async () => {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  try {
    const chrome = await readyChrome(app)

    // Absence cannot be polled for the instant chrome exists -- settle first
    // (scripts/smoke.mjs's own rule 3), then confirm it never showed up.
    await new Promise((resolve) => { setTimeout(resolve, ABSENCE_SETTLE_MS) })
    expect(await menuWebContentsId(app)).toBeUndefined()

    // hover(), not click(): moves the pointer onto the button without
    // pressing it, the same `pointerenter` a real user's mouse fires.
    await chrome.hover('#menu')
    expect(await waitFor(async () => await menuWebContentsId(app) !== undefined)).toBe(true)
    const builtOnHover = await menuWebContentsId(app)

    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
    await menuPage(app)?.waitForSelector('.menu-row')
    expect(await menuWebContentsId(app)).toBe(builtOnHover)

    // Close (the same button toggles it) and reopen: the webContents
    // survives being hidden (popoverShown reads that; app.windows() cannot --
    // see popoverShown's own doc) and is the SAME one, never rebuilt.
    await chrome.click('#menu')
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=menu')))).toBe(true)

    // Past REOPEN_DEBOUNCE_MS (press-stamps.ts): an immediate second toggle
    // is read as this close's own echo, not fresh intent -- correct for a
    // real click-away, but this test's own explicit close needs to clear it
    // before reopening on purpose.
    await new Promise((resolve) => { setTimeout(resolve, 350) })
    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
    await menuPage(app)?.waitForSelector('.menu-row')
    expect(await menuWebContentsId(app)).toBe(builtOnHover)
  } finally {
    await closeElectron(app)
    expect(await assertNoElectronSurvivors()).toEqual([])
  }
}, TEST_TIMEOUT_MS)

it('a click with no prior hover still opens the menu, building it then', async () => {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  try {
    const chrome = await readyChrome(app)

    // A programmatic click, unlike chrome.click(), moves no real pointer --
    // no `pointerenter` fires, matching a keyboard Enter on a button that
    // was tab-stopped to without a preceding hover.
    await chrome.evaluate(() => { document.querySelector<HTMLButtonElement>('#menu')?.click() })

    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
    await menuPage(app)?.waitForSelector('.menu-row')
  } finally {
    await closeElectron(app)
    expect(await assertNoElectronSurvivors()).toEqual([])
  }
}, TEST_TIMEOUT_MS)

it('a brand-new tab is painted the dashboard\'s own colour before its page ever loads', async () => {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  try {
    const chrome = await readyChrome(app)

    const before = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((wc) => wc.id))
    await chrome.click('#new-tab')

    // recordViewBackground (view-background-test-hook.ts) runs synchronously
    // inside makeTabView(), before loadURL -- so once the fresh tab's
    // webContents exists at all, its recorded colour already does too; the
    // loop below is generous room for the FIRST half of that (the fresh
    // webContents appearing) under load, not a real race between the two.
    const recorded = await app.evaluate(async ({ webContents }, knownIds: number[]) => {
      for (let i = 0; i < 3_000; i++) {
        const fresh = webContents.getAllWebContents().find((wc) => wc.getURL().includes('/newtab/') && !knownIds.includes(wc.id))
        const map = (globalThis as unknown as { __orivonDevViewBackgrounds?: Map<number, string> }).__orivonDevViewBackgrounds
        if (fresh !== undefined && map?.has(fresh.id) === true) return map.get(fresh.id)
        await new Promise((resolve) => { setTimeout(resolve, 5) })
      }
      return undefined
    }, before)

    // theme-colors.ts's DASHBOARD_BACKGROUND -- the same value in both themes, so
    // this needs no assumption about which one the test machine is in.
    expect(recorded).toBe('#394244')
  } finally {
    await closeElectron(app)
    expect(await assertNoElectronSurvivors()).toEqual([])
  }
}, TEST_TIMEOUT_MS)

/** What a reopened menu must be: the topmost child of its window, with a real size, painting more than one colour. */
async function expectMenuOnScreen (app: Awaited<ReturnType<typeof launchElectron>>, path: string): Promise<void> {
  const top = await app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0]
    const view = win?.contentView.children.at(-1) as { webContents?: { getURL: () => string }, getBounds: () => { width: number, height: number } } | undefined
    return view === undefined ? null : { url: view.webContents?.getURL() ?? '', bounds: view.getBounds() }
  })
  expect({ path, topmost: top?.url.includes('overlay=menu') }).toEqual({ path, topmost: true })
  expect(top?.bounds.width ?? 0).toBeGreaterThan(100)
  expect(top?.bounds.height ?? 0).toBeGreaterThan(100)
  const page = menuPage(app)
  expect(page).toBeDefined()
  await page?.waitForSelector('.menu-row')
  expect({ path, colours: distinctColours(await (page as NonNullable<typeof page>).screenshot()) > 3 }).toEqual({ path, colours: true })
}

it('reopens on screen after every way it can have been closed', async () => {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  try {
    const chrome = await readyChrome(app)
    const shown = async (): Promise<boolean> => await popoverShown(app, 'overlay=menu')
    const open = async (): Promise<void> => {
      // Past REOPEN_DEBOUNCE_MS: a toggle just after a close that was a blur reads as that close's echo.
      await new Promise((resolve) => { setTimeout(resolve, 450) })
      await chrome.click('#menu')
      expect(await waitFor(shown)).toBe(true)
    }
    const closedBy: Record<string, () => Promise<void>> = {
      'the button again': async () => { await chrome.click('#menu') },
      'a click into the page': async () => {
        await app.evaluate(({ webContents }) => { webContents.getAllWebContents().find((wc) => wc.getType() === 'window' && /\/newtab\//.test(wc.getURL()))?.focus() })
      },
      Escape: async () => { await pressKey(app, 'overlay=menu', 'Escape') },
      'choosing a row': async () => {
        await menuPage(app)?.locator('.menu-row', { hasText: 'Settings' }).first().click()
      },
      'the window losing focus': async () => {
        await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.blur() })
        await app.evaluate(({ webContents }) => { webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/renderer/index.html'))?.focus() })
      }
    }

    await open()
    await expectMenuOnScreen(app, 'first open')
    for (const [path, close] of Object.entries(closedBy)) {
      await close()
      expect({ path, closed: await waitFor(async () => !(await shown())) }).toEqual({ path, closed: true })
      await open()
      await expectMenuOnScreen(app, path)
    }
  } finally {
    await closeElectron(app)
    expect(await assertNoElectronSurvivors()).toEqual([])
  }
}, 90_000)

it('a press held on the button while the menu is open closes it, and letting go does not reopen it', async () => {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  try {
    const chrome = await readyChrome(app)
    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
    await menuPage(app)?.waitForSelector('.menu-row')

    const box = await chrome.locator('#menu').boundingBox()
    if (box === null) throw new Error('the menu button has no box')
    await chrome.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await chrome.mouse.down()
    // Stand-in for what a real press does on landing: the keyboard focus moves to the toolbar, so the menu loses it and
    // closes. Playwright's mouse sends no such focus change; the real path is the XTest recipe in docs/development/testing.md.
    await app.evaluate(({ webContents }) => { webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/renderer/index.html'))?.focus() })
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=menu')))).toBe(true)
    // Held well past the time a blur-close is taken to be the echo of the click that follows.
    await new Promise((resolve) => { setTimeout(resolve, 700) })
    await chrome.mouse.up()

    // A refusal is an absence: wait it out, then read once.
    await new Promise((resolve) => { setTimeout(resolve, ABSENCE_SETTLE_MS) })
    expect(await popoverShown(app, 'overlay=menu')).toBe(false)

    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
  } finally {
    await closeElectron(app)
    expect(await assertNoElectronSurvivors()).toEqual([])
  }
}, TEST_TIMEOUT_MS)
