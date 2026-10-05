// What the sign-in and certificate e2e files share: finding an overlay's page, asking whether it is on screen,
// and photographing it in both colour schemes when ORIVON_UI_SHOTS_DIR is set.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { expect } from 'vitest'
import { delay, waitFor } from './smoke-helpers.mjs'

export const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR

/** Whether any web contents of this overlay is attached now; a closed overlay's page can linger in the list. */
export async function overlayShown (app: ElectronApplication, name: string): Promise<boolean> {
  return await app.evaluate(({ webContents }, part) => {
    const shown = (globalThis as { __orivonDevPopoverShown?: Set<number> }).__orivonDevPopoverShown
    return webContents.getAllWebContents().some((wc) => !wc.isDestroyed() && wc.getURL().includes(part) && shown?.has(wc.id) === true)
  }, `overlay=${name}`)
}

/** The page of an overlay that is on screen, once it is. */
export async function waitOverlay (app: ElectronApplication, name: string): Promise<Page> {
  expect(await waitFor(async () => await overlayShown(app, name)), `${name} shown`).toBe(true)
  let page: Page | undefined
  expect(await waitFor(() => {
    page = app.windows().filter((w) => w.url().includes(`overlay=${name}`) && !w.isClosed()).at(-1)
    return page !== undefined
  })).toBe(true)
  return page as Page
}

export async function runCommand (chrome: Page, id: string): Promise<void> {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}

export async function setScheme (app: ElectronApplication, pages: Page[], scheme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
  for (const page of pages) await page.emulateMedia({ colorScheme: scheme }).catch(() => undefined)
  await delay(250)
}

/** Photographs `page` in light and dark into the shots directory, then puts the light scheme back. */
export async function shoot (app: ElectronApplication, chrome: Page, page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['dark', 'light'] as const) {
    await setScheme(app, [chrome, page], scheme)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
}

/** A click or key that ends by closing the very page it was sent to is not a failure. */
export async function safely (action: Promise<unknown>): Promise<void> {
  await action.catch((error: unknown) => {
    if (!/closed|destroyed|detached/i.test(String(error))) throw error
  })
}
