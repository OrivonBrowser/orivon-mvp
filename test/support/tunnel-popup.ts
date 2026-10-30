// What a spec does with the list the tunnels button opens on a website. A row of that list sets the TAB's tunnel; the website's own
// entry in routes.json is made only by "Always use for this site". `pickTunnelForWebsite` is the whole permanent choice: use it
// where a spec's point is the entry, and press the row alone (`openTunnelList` then a click) where its point is what the tab does.
import { expect } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { delay, waitFor, waitForTab } from './smoke-helpers.mjs'

export type TunnelRow = 'nym' | 'socks5'

/** The page the website must show again once the tab has moved into the tunnel's session. */
export interface Arrival { readonly address: string, readonly title: string }

export const findTunnelList = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

/** The list of the front tab, opened with the real button unless it is open already, waited for until its `row` switch is drawn. */
export async function openTunnelList (app: ElectronApplication, chrome: Page, row: TunnelRow = 'nym'): Promise<Page> {
  if (findTunnelList(app) === undefined) await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findTunnelList(app) !== undefined), 'the tunnels list opened').toBe(true)
  const list = findTunnelList(app) as Page
  await list.waitForSelector(`#tunnel-switch-${row}`)
  return list
}

/** The list closed with the button that opened it, and settled: a view that closes under a click is not a state to read. */
export async function closeTunnelList (app: ElectronApplication, chrome: Page): Promise<void> {
  if (findTunnelList(app) === undefined) return
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findTunnelList(app) === undefined), 'the tunnels list closed').toBe(true)
  await delay(300)
}

/** Whether "Always use for this site" is on in the list now showing. */
export async function alwaysIsOn (list: Page): Promise<boolean> {
  return await list.locator('#tunnel-switch-always').getAttribute('aria-checked') === 'true'
}

/**
 * Presses "Always use for this site" until the list says it is on, reopening the list when the page's move closed it.
 * A press is made only while the switch is off, so a list that closed after a press that took is not pressed back.
 */
export async function pressAlways (app: ElectronApplication, chrome: Page, row: TunnelRow = 'nym'): Promise<void> {
  const done = async (): Promise<boolean> => {
    const list = await openTunnelList(app, chrome, row)
    await list.waitForSelector('#tunnel-switch-always')
    if (await alwaysIsOn(list)) return true
    await list.click('#tunnel-switch-always')
    return await waitFor(async () => await alwaysIsOn(list).catch(() => false))
  }
  let on = false
  for (let attempt = 0; attempt < 3 && !on; attempt++) on = await done().catch(() => false)
  expect(on, 'the website has its tunnel for good').toBe(true)
}

/**
 * Gives the website on the front tab a tunnel of its own, as a person does: presses the row, confirms the storage question the
 * first move into a tunnel profile asks, waits for the website to show again from that tunnel, and presses Always. The tab ends
 * on the website with the entry saved and the list closed.
 */
export async function pickTunnelForWebsite (app: ElectronApplication, chrome: Page, row: TunnelRow, arrival: Arrival): Promise<void> {
  const list = await openTunnelList(app, chrome, row)
  await list.click(`#tunnel-switch-${row}`)
  await list.waitForSelector('.tunnel-notice')
  await list.click('#tunnel-notice-confirm')
  expect((await waitForTab(chrome, arrival, 60_000)).ok, 'the website came back through its tunnel').toBe(true)
  await pressAlways(app, chrome, row)
  await closeTunnelList(app, chrome)
}
