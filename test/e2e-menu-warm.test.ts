// The main menu is kept warm (shell/popover-view.ts's `warm`): once built,
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
    webContents.getAllWebContents().find((wc) => wc.getURL().includes('/menu/'))?.id)
}

function menuPage (app: Awaited<ReturnType<typeof launchElectron>>): ReturnType<typeof app.windows>[number] | undefined {
  return app.windows().find((w) => w.url().endsWith('/menu/index.html'))
}

it('builds no menu view at launch, builds one on the button\'s own hover, and reuses it on every open', async () => {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)

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
    expect(await waitFor(async () => await popoverShown(app, '/menu/'))).toBe(true)
    await menuPage(app)?.waitForSelector('.item')
    expect(await menuWebContentsId(app)).toBe(builtOnHover)

    // Close (the same button toggles it) and reopen: the webContents
    // survives being hidden (popoverShown reads that; app.windows() cannot --
    // see popoverShown's own doc) and is the SAME one, never rebuilt.
    await chrome.click('#menu')
    expect(await waitFor(async () => !(await popoverShown(app, '/menu/')))).toBe(true)

    // Past REOPEN_DEBOUNCE_MS (popover-view.ts): an immediate second toggle
    // is read as this close's own echo, not fresh intent -- correct for a
    // real click-away, but this test's own explicit close needs to clear it
    // before reopening on purpose.
    await new Promise((resolve) => { setTimeout(resolve, 350) })
    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, '/menu/'))).toBe(true)
    await menuPage(app)?.waitForSelector('.item')
    expect(await menuWebContentsId(app)).toBe(builtOnHover)
  } finally {
    await closeElectron(app)
    expect(await assertNoElectronSurvivors()).toEqual([])
  }
}, TEST_TIMEOUT_MS)

it('a click with no prior hover still opens the menu, building it then', async () => {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)

    // A programmatic click, unlike chrome.click(), moves no real pointer --
    // no `pointerenter` fires, matching a keyboard Enter on a button that
    // was tab-stopped to without a preceding hover.
    await chrome.evaluate(() => { document.querySelector<HTMLButtonElement>('#menu')?.click() })

    expect(await waitFor(async () => await popoverShown(app, '/menu/'))).toBe(true)
    await menuPage(app)?.waitForSelector('.item')
  } finally {
    await closeElectron(app)
    expect(await assertNoElectronSurvivors()).toEqual([])
  }
}, TEST_TIMEOUT_MS)

it('a brand-new tab is painted the app\'s own dark wash before its page ever loads', async () => {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)

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

    // theme-colors.ts's APP_DARK_WASH -- the same value in both themes, so
    // this needs no assumption about which one the test machine is in.
    expect(recorded).toBe('#0d0e14')
  } finally {
    await closeElectron(app)
    expect(await assertNoElectronSurvivors()).toEqual([])
  }
}, TEST_TIMEOUT_MS)
