// Driving the bookmark bubble and the all-tabs sheet from an e2e test: finding the overlay's page and pressing
// its buttons. A button that closes the overlay ends the page it was pressed on, which Playwright reports as an
// error that is not a failure.
import type { ElectronApplication, Page } from 'playwright'
import { expect } from 'vitest'
import { popoverShown, waitFor } from './smoke-helpers.mjs'

export const EDIT = 'bookmark-edit'
export const ALL_TABS = 'bookmark-all-tabs'

const isClosed = (error: unknown): boolean => /has been closed|Target closed|Target page, context or browser has been closed/.test(String(error))

/** Runs an action that closes the overlay it acts on. */
export async function closing (action: () => Promise<unknown>): Promise<void> {
  await action().catch((error: unknown) => { if (!isClosed(error)) throw error })
}

/** The overlay's page once it is shown and built. */
export async function overlayPage (app: ElectronApplication, name: string = EDIT): Promise<Page> {
  expect(await waitFor(async () => await popoverShown(app, `overlay=${name}`))).toBe(true)
  expect(await waitFor(() => app.windows().some((w) => w.url().includes(`overlay=${name}`)))).toBe(true)
  const page = app.windows().find((w) => w.url().includes(`overlay=${name}`)) as Page
  await page.waitForSelector('.bme .btn-row')
  await page.waitForFunction(() => document.activeElement instanceof HTMLInputElement)
  return page
}

export const overlayOpen = async (app: ElectronApplication, name: string = EDIT): Promise<boolean> => await popoverShown(app, `overlay=${name}`)

/** The star's click, then the bubble's Remove: what unstarring a page is now. */
export async function removeThroughBubble (app: ElectronApplication, chrome: Page): Promise<void> {
  await chrome.click('#bookmark-toggle')
  const bubble = await overlayPage(app)
  await closing(async () => await bubble.click('.btn.remove'))
}
