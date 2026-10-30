// What a spec does with the list the tunnels button opens on a website. A row of that list sets the TAB's tunnel; the website's own
// entry in routes.json is made only by "Always use for this site". `pickTunnelForWebsite` is the whole permanent choice: use it
// where a spec's point is the entry, and press the row alone (`openTunnelList` then a click) where its point is what the tab does.
import { expect } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { delay, waitFor } from './smoke-helpers.mjs'

export type TunnelRow = 'nym' | 'socks5'

/** Where the website's page must be once the tab has moved into the tunnel's session. */
export interface Arrival { readonly inProfile: () => Promise<boolean> }

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
 * Presses the row `row` of the list on the front tab and answers the storage question when it is asked. The question comes the
 * first time a website moves into a profile and not again once a tab has visited it there (the visit is recorded as storage kept
 * apart), so a press that is not asked simply moves the tab, and the list closes with the page's move.
 */
export async function pressRow (app: ElectronApplication, chrome: Page, row: TunnelRow): Promise<void> {
  const list = await openTunnelList(app, chrome, row)
  await list.click(`#tunnel-switch-${row}`)
  const asked = await list.waitForSelector('#tunnel-notice-confirm', { timeout: 10_000 }).then(() => true, () => false)
  if (asked) await list.click('#tunnel-notice-confirm')
}

/**
 * Gives the website on the front tab a tunnel of its own, as a person does: presses the row, answers the storage question when it
 * is asked, waits for the website to be in the tunnel's session, and presses Always. The tab ends on the website with the entry
 * saved and the list closed.
 */
export async function pickTunnelForWebsite (app: ElectronApplication, chrome: Page, row: TunnelRow, arrival: Arrival): Promise<void> {
  await pressRow(app, chrome, row)
  expect(await waitFor(arrival.inProfile, 60_000), 'the website came back in its tunnel\'s session').toBe(true)
  await pressAlways(app, chrome, row)
  await closeTunnelList(app, chrome)
}
