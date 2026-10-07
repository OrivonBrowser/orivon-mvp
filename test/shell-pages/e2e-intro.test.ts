// The welcome screen (src/main/shell/intro-view.ts, src/renderer/intro/), on a
// real launch: when it shows, that it covers the window and stays on top, that
// "Enter Orivon" reveals the dashboard, and that only `once` remembers the
// click. launch-electron.mjs turns it off by default, so every other suite
// keeps its two-window launch; each test here asks for a mode explicitly.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { readFocusLog, startFocusLog } from '../support/focus-helpers.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'
import { NOTICE_CHANGES, NOTICE_VERSION } from '../../src/telemetry/consent.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 45_000

function launch (mode: string, seed?: (dir: string) => Promise<void>, env: Record<string, string> = {}): Promise<ElectronApplication> {
  return launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: { ORIVON_INTRO: mode, ...env },
    // The welcome screen covers the chrome view, which draws nothing while it does: there is no ready chrome to wait for.
    chrome: false,
    ...(seed === undefined ? {} : { seedProfile: seed })
  })
}

const introPage = (app: ElectronApplication): Page | undefined =>
  app.windows().find((w) => w.url().includes('/intro/index.html'))
const dashboardPage = (app: ElectronApplication): Page | undefined =>
  app.windows().find((w) => w.url().endsWith('/newtab/index.html'))

/** Chrome view, dashboard tab and (when showing) the intro: the same count the other suites wait on, plus one. */
const windowCount = (app: ElectronApplication): number => app.windows().length

const userDataDir = (app: ElectronApplication): Promise<string> => app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))

async function untilShell (app: ElectronApplication): Promise<void> {
  expect(await waitFor(() => dashboardPage(app) !== undefined)).toBe(true)
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
}

it('once, on a fresh profile: shows over the whole window, stays on top of a new tab, and Enter reveals the dashboard and is remembered', async () => {
  const app = await launch('once')
  try {
    expect(await waitFor(() => introPage(app) !== undefined && windowCount(app) === 3)).toBe(true)
    const intro = introPage(app)
    if (intro === undefined) throw new Error('unreachable: waited for it above')

    expect(await intro.getAttribute('h1.headline', 'aria-label')).toBe('The browser Web3 deserves.')
    expect(await intro.textContent('#enter')).toContain('Enter Orivon')
    // A view in a window not shown yet has no viewport (0 x 0); the window shows once the chrome has painted.
    expect(await waitFor(async () => await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.isVisible() === true))).toBe(true)
    const content = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getContentBounds())
    expect(await intro.evaluate(() => [innerWidth, innerHeight])).toEqual([content?.width, content?.height])

    // The keyboard is the welcome screen's in the main process, not only in its document: the dashboard's search box under it does not hold it.
    const focusedUrls = (): Promise<string[]> => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().filter((wc) => wc.isFocused()).map((wc) => wc.getURL()))
    expect(await waitFor(async () => (await focusedUrls()).some((url) => url.includes('/intro/index.html')))).toBe(true)
    expect((await focusedUrls()).some((url) => url.includes('/newtab/'))).toBe(false)

    // A new tab re-adds its view to the window, which would bury the intro
    // without keepOnTop; it must still be the topmost view afterwards.
    await findChrome(app).evaluate(() => { (window as unknown as { orivonShell: { newTab: () => void } }).orivonShell.newTab() })
    expect(await waitFor(() => windowCount(app) === 4)).toBe(true)
    const topmost = await app.evaluate(({ BaseWindow }) => {
      const last = BaseWindow.getAllWindows()[0]?.contentView.children.at(-1) as unknown as { webContents: Electron.WebContents }
      return last.webContents.getURL()
    })
    expect(topmost).toContain('/intro/index.html')

    // The screen takes the keyboard on its own: Enter alone leaves it, no Tab first.
    expect(await waitFor(async () => (await intro.evaluate(() => document.activeElement?.id)) === 'enter')).toBe(true)
    await intro.keyboard.press('Enter')
    expect(await waitFor(() => introPage(app) === undefined && windowCount(app) === 3)).toBe(true)

    // Entering gives the keyboard to the address bar: the new tab in front is a start page, and the bar is where a person types.
    const chrome = findChrome(app)
    const barActive = (): Promise<boolean> => chrome.evaluate(() => document.activeElement?.id === 'address')
    expect(await waitFor(async () => (await focusedUrls()).some((url) => url.includes('/renderer/index.html')) && await barActive())).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect((await focusedUrls()).some((url) => url.includes('/newtab/'))).toBe(false)
    expect(await barActive()).toBe(true)

    const dashboard = dashboardPage(app)
    if (dashboard === undefined) throw new Error('the dashboard tab is gone')
    // The background picture is a real, decodable file at the built path.
    const decoded = await dashboard.evaluate(async () => {
      const url = /url\("?([^")]+)"?\)/.exec(getComputedStyle(document.documentElement).backgroundImage)?.[1]
      if (url === undefined) return 'no background-image url'
      const image = new Image()
      image.src = url
      await image.decode()
      return image.naturalWidth
    })
    expect(decoded).toBe(2398)

    const seenFile = join(await userDataDir(app), 'intro.json')
    expect(await waitFor(() => existsSync(seenFile))).toBe(true)
    expect(JSON.parse(await readFile(seenFile, 'utf8'))).toEqual({ seen: true })

    // The first letter typed builds the dropdown, and its page does not take the keyboard from the field.
    await startFocusLog(app)
    await chrome.keyboard.type('a', { delay: 25 })
    expect(await waitFor(() => popoverShown(app, 'overlay=omnibox'))).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    const taken = await readFocusLog(app)
    expect(taken.filter((url) => url === 'blank' || url.includes('overlay=omnibox'))).toEqual([])
    expect((await focusedUrls()).some((url) => url.includes('/renderer/index.html'))).toBe(true)
    expect(await barActive()).toBe(true)
  } finally {
    // Two tabs are open here, and closing the app under them throws in main (A259).
    await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)

it('once, on a profile that has already seen it: opens straight on the dashboard', async () => {
  const app = await launch('once', (dir) => writeFile(join(dir, 'intro.json'), '{"seen":true}', 'utf8'))
  try {
    await untilShell(app)
    // Absence cannot be polled for: wait out the time the view would have taken.
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(introPage(app)).toBeUndefined()
    expect(windowCount(app)).toBe(2)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('always: shows even when seen, and clicking through does not use up the one-time showing', async () => {
  const app = await launch('always', (dir) => writeFile(join(dir, 'intro.json'), '{"seen":true}', 'utf8'))
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    await introPage(app)?.click('#enter')
    expect(await waitFor(() => introPage(app) === undefined && windowCount(app) === 2)).toBe(true)
  } finally {
    await closeElectron(app)
  }

  const fresh = await launch('always')
  try {
    expect(await waitFor(() => introPage(fresh) !== undefined)).toBe(true)
    await introPage(fresh)?.click('#enter')
    expect(await waitFor(() => introPage(fresh) === undefined && windowCount(fresh) === 2)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(existsSync(join(await userDataDir(fresh), 'intro.json'))).toBe(false)
  } finally {
    await closeElectron(fresh)
  }
}, TEST_TIMEOUT_MS * 2)

const seamCalls = (app: ElectronApplication): Promise<{ setDefault: string[], isDefault: string[] }> =>
  app.evaluate(() => (globalThis as unknown as { __orivonDevDefaultBrowser: { setDefault: string[], isDefault: string[] } }).__orivonDevDefaultBrowser)

it('offers no default-browser box, even where it can register, and entering registers nothing', async () => {
  const app = await launch('always', undefined, { ORIVON_TEST_DEFAULT_BROWSER: 'can-set' })
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    expect(await intro.locator('#enter').isVisible()).toBe(true)
    expect(await intro.locator('input[type="checkbox"]').count()).toBe(0)
    expect(await intro.locator('text=default browser').count()).toBe(0)
    await intro.click('#enter')
    expect(await waitFor(() => introPage(app) === undefined)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect((await seamCalls(app)).setDefault).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('the default test launch opens without it', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await untilShell(app)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(introPage(app)).toBeUndefined()
    expect(windowCount(app)).toBe(2)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// The telemetry question: with telemetry running, a person who has not chosen is asked before entering.
const homes: string[] = []
afterAll(async () => { await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }))) })

async function newHome (consent?: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orivon-telemetry-home-'))
  homes.push(home)
  if (consent !== undefined) await writeFile(join(home, 'consent.json'), JSON.stringify(consent), 'utf8')
  return home
}

const askingTelemetry = (home: string, extra: Record<string, string> = {}): Promise<ElectronApplication> =>
  launch('always', undefined, { ORIVON_TELEMETRY: 'on', ORIVON_TELEMETRY_HOME: home, ...extra })

async function consentOf (home: string): Promise<Record<string, unknown> | undefined> {
  const path = join(home, 'consent.json')
  if (!(await waitFor(() => existsSync(path), 10_000))) return undefined
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

/** Clicks "Enter Orivon" on a page that asks, and waits for the popup to be fully in. */
async function openPopup (intro: Page): Promise<void> {
  await intro.click('#enter')
  expect(await waitFor(async () => await intro.locator('#consent').isVisible())).toBe(true)
  expect(await waitFor(async () => Number(await intro.locator('.consent-card').evaluate((el) => getComputedStyle(el).opacity)) === 1)).toBe(true)
}

it('keeps the welcome page as it is, and "Enter Orivon" opens the telemetry popup over it: two equal buttons, neither chosen', async () => {
  const home = await newHome()
  const app = await askingTelemetry(home)
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    // The welcome page carries no question of its own: the single button, and nothing about telemetry until it is pressed.
    expect(await waitFor(async () => await intro.locator('#enter').isVisible())).toBe(true)
    expect(await intro.locator('#consent').isHidden()).toBe(true)
    await openPopup(intro)
    expect(new URL(intro.url()).hash).toBe('#asking')
    // Still on the welcome screen, which now holds nothing to press: the popup is the only way in.
    expect(introPage(app)).toBeDefined()
    expect(await intro.locator('#welcome').getAttribute('inert')).not.toBeNull()
    expect(await intro.textContent('#consent-title')).toBe('Support us for free through telemetry')
    expect(await intro.getAttribute('.consent-card', 'role')).toBe('dialog')
    expect(await intro.textContent('#consent-lead')).toContain('keeps your history on your computer')
    expect(await intro.locator('.consent-promises li').allTextContents()).toEqual(['No page addresses, searches or history', 'Your IP address is never kept', 'Never sold, never used for ads', 'Change your mind any time in Settings'])
    expect(await intro.locator('.consent-details li').count()).toBe(4)
    expect(await intro.locator('.consent-details li').nth(1).textContent()).toContain('Web2 sites are never named. They travel in a separate report under the same ID, so a forged report can be told apart.')
    expect(await intro.locator('.consent-details li').nth(2).textContent()).toContain('your country, from your time zone')

    const [acceptBox, denyBox] = await Promise.all(['#telemetry-accept', '#telemetry-deny'].map(async (selector) => await intro.locator(selector).boundingBox()))
    expect(acceptBox?.width).toBe(denyBox?.width)
    expect(acceptBox?.height).toBe(denyBox?.height)
    const styles = await Promise.all(['#telemetry-accept', '#telemetry-deny'].map(async (selector) => await intro.locator(selector).evaluate((el) => {
      const style = getComputedStyle(el)
      return [el.className, style.backgroundColor, style.color, style.borderColor, style.fontWeight, style.boxShadow]
    })))
    expect(styles[0]).toEqual(styles[1])
    expect(await intro.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
    expect(await intro.textContent('#telemetry-accept')).toBe('Accept')
    expect(await intro.textContent('#telemetry-deny')).toBe('Deny')
    expect(existsSync(join(home, 'consent.json'))).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows the browser under the popup, blurred: main captures the toolbar and the page and the popup fades them in whole', async () => {
  const home = await newHome()
  const app = await askingTelemetry(home)
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    await openPopup(intro)
    expect(await waitFor(async () => await intro.locator('#behind').evaluate((el) => el.classList.contains('shown')), 10_000)).toBe(true)
    const layers = await intro.locator('#behind img').evaluateAll((images) => images.map((el) => {
      const image = el as HTMLImageElement
      // Something was drawn: a capture of a view that never painted is one flat, see-through colour.
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d') as CanvasRenderingContext2D
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let opaque = 0
      for (let at = 3; at < pixels.length; at += 4) if ((pixels[at] ?? 0) > 0) opaque++
      return { top: parseFloat(image.style.top), height: parseFloat(image.style.height), width: parseFloat(image.style.width), png: image.src.startsWith('data:image/png;base64,'), opaque: opaque / (pixels.length / 4), filter: getComputedStyle(image).filter }
    }))
    // The chrome's rows at the top, and the dashboard tab under them down to the bottom edge.
    expect(layers.length).toBeGreaterThanOrEqual(2)
    expect(layers.some((layer) => layer.top === 0 && layer.height < 20)).toBe(true)
    expect(layers.some((layer) => layer.top > 0 && Math.abs(layer.top + layer.height - 100) < 0.01 && layer.width === 100)).toBe(true)
    for (const layer of layers) {
      expect(layer.png).toBe(true)
      expect(layer.opaque).toBeGreaterThan(0.9)
      expect(layer.filter).toBe('blur(26px) saturate(1.25)')
    }
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('does not leave on the Enter key while the popup is open, and says to choose one', async () => {
  const home = await newHome()
  const app = await askingTelemetry(home)
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    await openPopup(intro)
    await intro.keyboard.press('Enter')
    await intro.keyboard.press('Escape')
    expect(await waitFor(async () => (await intro.textContent('#telemetry-hint')) === 'Choose Accept or Deny to continue.')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(introPage(app)).toBeDefined()
    expect(await intro.locator('#consent').isVisible()).toBe(true)
    expect(existsSync(join(home, 'consent.json'))).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Accept records accepted for the whole computer, from the welcome screen, and lets the person in', async () => {
  const home = await newHome()
  const app = await askingTelemetry(home)
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    await openPopup(intro)
    await intro.click('#telemetry-accept')
    expect(await waitFor(() => introPage(app) === undefined && windowCount(app) === 2)).toBe(true)
    expect(await consentOf(home)).toMatchObject({ state: 'accepted', source: 'welcome', noticeVersion: NOTICE_VERSION })
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('Deny records declined, and the keyboard works: Tab to a button, then Enter', async () => {
  const home = await newHome()
  const app = await askingTelemetry(home)
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    await openPopup(intro)
    // The welcome page under it is inert: the first Tab lands in the popup, on "See exactly what is sent".
    await intro.keyboard.press('Tab')
    expect(await intro.evaluate(() => document.activeElement?.tagName)).toBe('SUMMARY')
    await intro.keyboard.press('Tab')
    expect(await intro.evaluate(() => document.activeElement?.id)).toBe('telemetry-accept')
    await intro.keyboard.press('Tab')
    expect(await intro.evaluate(() => document.activeElement?.id)).toBe('telemetry-deny')
    await intro.keyboard.press('Enter')
    expect(await waitFor(() => introPage(app) === undefined && windowCount(app) === 2)).toBe(true)
    expect(await consentOf(home)).toMatchObject({ state: 'declined', source: 'welcome' })
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('does not ask again once the computer has a choice, accepted or declined: Enter Orivon goes straight in', async () => {
  for (const state of ['accepted', 'declined']) {
    const home = await newHome({ state, atMs: Date.now(), noticeVersion: NOTICE_VERSION, source: 'settings' })
    const app = await askingTelemetry(home)
    try {
      expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
      const intro = introPage(app) as Page
      expect(await intro.locator('#enter').isVisible()).toBe(true)
      await intro.click('#enter')
      expect(await waitFor(() => introPage(app) === undefined && windowCount(app) === 2)).toBe(true)
      expect(((await consentOf(home)) ?? {})['state']).toBe(state)
    } finally {
      await closeElectron(app)
    }
  }
}, TEST_TIMEOUT_MS * 2)

it('asks again on a first showing when the notice has changed since an acceptance', async () => {
  const home = await newHome({ state: 'accepted', atMs: Date.now(), noticeVersion: 1, source: 'welcome' })
  const app = await askingTelemetry(home)
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    await openPopup(intro)
    expect(await intro.locator('#consent-changed').isVisible()).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('does not ask when telemetry is off for the launch, which is what every other spec gets', async () => {
  const app = await launch('always')
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    expect(await intro.locator('#enter').isVisible()).toBe(true)
    await intro.click('#enter')
    expect(await waitFor(() => introPage(app) === undefined && windowCount(app) === 2)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// An acceptance given under an older notice is asked again at the next start, on a screen already seen.
const seenProfile = (dir: string): Promise<void> => writeFile(join(dir, 'intro.json'), '{"seen":true}', 'utf8')
const staleAcceptance = { state: 'accepted', atMs: Date.UTC(2026, 8, 1), noticeVersion: NOTICE_VERSION - 1, source: 'welcome', everAccepted: true }
const renewing = (home: string): Promise<ElectronApplication> =>
  launch('once', seenProfile, { ORIVON_TELEMETRY: 'on', ORIVON_TELEMETRY_HOME: home })

it('asks again after the notice changed: the popup alone, with the change line, and one answer ends it', async () => {
  const home = await newHome(staleAcceptance)
  const app = await renewing(home)
  try {
    expect(await waitFor(() => introPage(app) !== undefined)).toBe(true)
    const intro = introPage(app) as Page
    expect(await waitFor(async () => await intro.locator('#consent').isVisible())).toBe(true)
    expect(await intro.locator('#welcome').isHidden()).toBe(true)
    expect(await intro.locator('#enter').isHidden()).toBe(true)
    expect(await intro.locator('#consent-changed').isVisible()).toBe(true)
    expect(await intro.textContent('#consent-changed p')).toBe('What changed since you agreed:')
    expect(await intro.locator('#consent-changed li').allTextContents()).toEqual([NOTICE_CHANGES[NOTICE_VERSION]])
    expect(await intro.locator('#telemetry-accept').isVisible()).toBe(true)
    expect(await intro.locator('#telemetry-deny').isVisible()).toBe(true)
    await intro.click('#telemetry-accept')
    expect(await waitFor(() => introPage(app) === undefined && windowCount(app) === 2)).toBe(true)
    expect(await waitFor(async () => (await consentOf(home))?.['noticeVersion'] === NOTICE_VERSION)).toBe(true)
    expect(await consentOf(home)).toMatchObject({ state: 'accepted', source: 'welcome', noticeVersion: NOTICE_VERSION })
  } finally {
    await closeElectron(app)
  }
  const second = await renewing(home)
  try {
    expect(await waitFor(() => windowCount(second) === 2)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(introPage(second)).toBeUndefined()
  } finally {
    await closeElectron(second)
  }
}, TEST_TIMEOUT_MS * 2)

it('does not ask again for an acceptance given under the current notice, on a screen already seen', async () => {
  const home = await newHome({ ...staleAcceptance, noticeVersion: NOTICE_VERSION })
  const app = await renewing(home)
  try {
    expect(await waitFor(() => windowCount(app) === 2)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))
    expect(introPage(app)).toBeUndefined()
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
