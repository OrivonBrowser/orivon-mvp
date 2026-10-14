// A middle-click on a tab closes it. On Linux Blink also pastes the selection into the focused field on the middle
// button's release unless the release is default-prevented, so with the address bar focused the paste would land in
// it before the tab went. The real clipboard is not driven (it hangs under xvfb): what is read is that the release is
// cancelled over a tab, that it is not over the field, and that the address text stayed.
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { waitForChromeReady } from '../support/e2e-helpers.js'
import { findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
const TYPED = 'text already in the address bar'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function launched (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  expect(await waitForChromeReady(chrome), 'the chrome view never became ready to act on').toBe(true)
  return { app, chrome }
}

async function centre (chrome: Page, selector: string): Promise<{ x: number, y: number }> {
  const box = await chrome.locator(selector).boundingBox()
  if (box === null) throw new Error(`${selector} has no box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

it('a middle release over a tab is cancelled, over the address field it is not', async () => {
  const { app, chrome } = await launched()
  try {
    await chrome.click('#new-tab')
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)
    await chrome.evaluate(() => {
      const seen: Array<{ target: string, prevented: boolean }> = []
      ;(window as unknown as { __releases: typeof seen }).__releases = seen
      window.addEventListener('mouseup', (event) => {
        if (event.button === 1) seen.push({ target: (event.target as HTMLElement).id || (event.target as HTMLElement).className, prevented: event.defaultPrevented })
      })
    })
    await chrome.focus('#address')
    await chrome.fill('#address', TYPED)

    const ids = await tabIds(chrome)
    const closing = ids[1] as string
    const at = await centre(chrome, `.tab[data-id="${closing}"]`)
    await chrome.mouse.click(at.x, at.y, { button: 'middle' })
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)
    expect(await chrome.inputValue('#address')).toBe(TYPED)

    const field = await centre(chrome, '#address')
    await chrome.mouse.click(field.x, field.y, { button: 'middle' })

    const releases = await chrome.evaluate(() => (window as unknown as { __releases: Array<{ target: string, prevented: boolean }> }).__releases)
    expect(releases).toHaveLength(2)
    expect(releases[0]?.prevented).toBe(true)
    expect(releases[1]).toMatchObject({ target: 'address', prevented: false })
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
