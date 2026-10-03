// The colour a view or the window shows before a page has painted, in each theme. Lifting Playwright's light
// pin (launch-electron.mjs's `scheme`) is what lets these checks see the dark theme at all; the backing
// colours are read through view-background-test-hook.ts and BaseWindow.getBackgroundColor(), since a settled
// screenshot cannot catch a frame that lasts a moment.

import pngjs from 'pngjs'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { setScheme } from './e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from './launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from './qa-helpers.js'
import { waitFor } from './smoke-helpers.mjs'

const DASHBOARD = { light: '#394244', dark: '#0d0e14' }
const WHITE = '#ffffff'
const INTERNAL = { light: '#f4f4f8', dark: '#17181c' }

type Shell = { orivonShell: { openInternal: (page: string) => void } }

let server: FixtureServer
beforeAll(async () => {
  server = await startServer((_req, res) => {
    html(res, '<!doctype html><meta charset="utf-8"><title>Fixture page</title><body>Plain page with no background of its own</body>')
  })
})
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const dashboardId = (app: ElectronApplication): Promise<number | undefined> =>
  app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.getURL().includes('/newtab/'))?.id)

const recorded = (app: ElectronApplication, id: number): Promise<string | undefined> =>
  app.evaluate((_e, wcId: number) => (globalThis as unknown as { __orivonDevViewBackgrounds?: Map<number, string> }).__orivonDevViewBackgrounds?.get(wcId)?.toLowerCase(), id)

const windowBackground = (app: ElectronApplication): Promise<string> =>
  app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getBackgroundColor().toLowerCase() ?? '')

const scheme = (page: Page): Promise<string> =>
  page.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))

it('a dark launch shows dark in the chrome and in a tab opened later; the default launch shows light', async () => {
  const dark = await launchShell({ scheme: 'dark' })
  try {
    expect(await scheme(dark.chrome)).toBe('dark')
    const tab = await visit(dark.app, dark.chrome, `${server.origin}/`)
    expect(await scheme(tab)).toBe('dark')
  } finally {
    await closeElectron(dark.app)
  }
  const plain = await launchShell()
  try {
    expect(await scheme(plain.chrome)).toBe('light')
  } finally {
    await closeElectron(plain.app)
  }
}, QA_TEST_TIMEOUT_MS)

for (const mode of ['light', 'dark'] as const) {
  it(`in ${mode}: the dashboard tab's backing follows the page it is going to, and the window behind the views follows the tab shown`, async () => {
    const { app, chrome } = await launchShell({ scheme: mode })
    try {
      let id: number | undefined
      expect(await waitFor(async () => { id = await dashboardId(app); return id !== undefined && (await recorded(app, id)) !== undefined })).toBe(true)
      const dash = id as number
      expect(await recorded(app, dash)).toBe(DASHBOARD[mode])
      expect(await windowBackground(app)).toBe(DASHBOARD[mode])

      // What the view holds the moment each main-frame navigation starts, read after the shell's own listeners ran.
      await app.evaluate(({ webContents }, wcId: number) => {
        const wc = webContents.fromId(wcId)
        const g = globalThis as unknown as { __orivonDevViewBackgrounds?: Map<number, string>, __startColours?: string[] }
        g.__startColours = []
        wc?.on('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument) g.__startColours?.push(`${details.url}|${g.__orivonDevViewBackgrounds?.get(wcId)?.toLowerCase() ?? ''}`)
        })
      }, dash)
      const startColours = (): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { __startColours: string[] }).__startColours)

      const siteUrl = `${server.origin}/`
      await visit(app, chrome, siteUrl)
      expect((await startColours()).find((c) => c.startsWith(siteUrl))).toBe(`${siteUrl}|${WHITE}`)
      expect(await recorded(app, dash)).toBe(WHITE)
      expect(await waitFor(async () => (await windowBackground(app)) === WHITE)).toBe(true)

      await chrome.click('#back')
      expect(await waitFor(async () => (await dashboardId(app)) === dash)).toBe(true)
      const toDashboard = (await startColours()).find((c) => c.includes('/newtab/'))
      expect(toDashboard?.endsWith(`|${DASHBOARD[mode]}`)).toBe(true)
      expect(await waitFor(async () => (await recorded(app, dash)) === DASHBOARD[mode])).toBe(true)
      expect(await waitFor(async () => (await windowBackground(app)) === DASHBOARD[mode])).toBe(true)

      await chrome.evaluate((n) => { (window as unknown as Shell).orivonShell.openInternal(n) }, 'history')
      expect(await waitFor(async () => (await windowBackground(app)) === INTERNAL[mode])).toBe(true)
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)
}

it('a change of scheme at run time moves the window behind the views with the tab shown', async () => {
  const { app, chrome } = await launchShell({ scheme: 'light' })
  try {
    await chrome.evaluate((n) => { (window as unknown as Shell).orivonShell.openInternal(n) }, 'history')
    expect(await waitFor(async () => (await windowBackground(app)) === INTERNAL.light)).toBe(true)
    await setScheme(app, 'dark')
    expect(await waitFor(async () => (await windowBackground(app)) === INTERNAL.dark)).toBe(true)
    expect(await scheme(chrome)).toBe('dark')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

type NewTabShell = { orivonShell: { newTab: () => void } }

for (const mode of ['light', 'dark'] as const) {
  it(`in ${mode}: a new tab never shows the window or its view in a colour other than the dashboard's, and its page starts on that colour`, async () => {
    const { app, chrome } = await launchShell({ scheme: mode })
    try {
      const dashboards = (): Promise<number[]> =>
        app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.getURL().includes('/newtab/')).map((wc) => wc.id))
      expect(await waitFor(async () => (await dashboards()).length === 1)).toBe(true)
      const [first] = await dashboards()

      // Every colour the window and any dashboard view holds, sampled every millisecond from before the tab exists
      // until its page has loaded: a flash lasts a few frames, so the settled state cannot show it.
      await app.evaluate(({ BaseWindow, webContents }) => {
        const g = globalThis as unknown as { __seen: Set<string>, __seenTimer?: NodeJS.Timeout, __orivonDevViewBackgrounds?: Map<number, string> }
        g.__seen = new Set()
        g.__seenTimer = setInterval(() => {
          const win = BaseWindow.getAllWindows()[0]
          if (win === undefined) return
          g.__seen.add(`window ${win.getBackgroundColor().toLowerCase()}`)
          for (const wc of webContents.getAllWebContents()) {
            const colour = g.__orivonDevViewBackgrounds?.get(wc.id)
            if (colour !== undefined && (wc.getURL() === '' || wc.getURL().includes('/newtab/'))) g.__seen.add(`view ${colour.toLowerCase()}`)
          }
        }, 1)
      })
      await chrome.evaluate(() => { (window as unknown as NewTabShell).orivonShell.newTab() })
      expect(await waitFor(async () => (await dashboards()).length === 2)).toBe(true)
      const fresh = (await dashboards()).find((id) => id !== first) as number
      const loaded = await app.evaluate(async ({ webContents }, id: number) => {
        const wc = webContents.fromId(id)
        for (let i = 0; i < 2_000 && wc !== undefined && (wc.isLoading() || wc.getURL() === ''); i++) await new Promise((r) => { setTimeout(r, 5) })
        return wc?.isLoading() === false
      }, fresh)
      expect(loaded).toBe(true)
      const seen = await app.evaluate(() => {
        const g = globalThis as unknown as { __seen: Set<string>, __seenTimer?: NodeJS.Timeout }
        if (g.__seenTimer !== undefined) clearInterval(g.__seenTimer)
        return [...g.__seen].sort()
      })
      expect(seen).toEqual([`view ${DASHBOARD[mode]}`, `window ${DASHBOARD[mode]}`])

      // The page: its root colour is the backing colour, and with its picture taken off, the wash over its base layer
      // composites to the same colour, so the step from the view's colour to the page's first frame is none. A view
      // that is off the screen cannot paint and its capture waits out its timeout, so only the pages that can be read are.
      const pages = app.windows().filter((p) => p.url().includes('/newtab/'))
      expect(pages.length).toBe(2)
      let read = 0
      for (const page of pages) {
        const root = await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement)
          const withoutPicture = style.backgroundImage.replace(/,\s*url\([^)]*\)/, '')
          const sheet = document.createElement('style')
          sheet.textContent = `html { background-image: ${withoutPicture} !important; }`
          document.head.append(sheet)
          return { colour: style.backgroundColor }
        })
        expect(root.colour).toBe(mode === 'light' ? 'rgb(57, 66, 68)' : 'rgb(13, 14, 20)')
        const shot = await page.screenshot({ clip: { x: 4, y: 4, width: 1, height: 1 }, timeout: 4_000 }).catch(() => null)
        if (shot === null) continue
        read++
        const png = pngjs.PNG.sync.read(shot)
        const painted = `#${[0, 1, 2].map((at) => (png.data[at] ?? 0).toString(16).padStart(2, '0')).join('')}`
        for (const at of [0, 1, 2]) expect(Math.abs((png.data[at] ?? 0) - Number.parseInt(DASHBOARD[mode].slice(1 + at * 2, 3 + at * 2), 16)), painted).toBeLessThanOrEqual(2)
      }
      expect(read).toBeGreaterThanOrEqual(1)
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)
}
