// Copying the address bar's whole address, in the running shell: Ctrl+C, the field's own Copy and a copy event all put
// the address on the clipboard as text and, for a .eth address, as a link to its eth.limo form; a part of the
// address is left to the browser, and an ordinary web address is written as plain text. On Linux the
// clipboard calls are replaced in the main process and recorded, because a real clipboard round trip can hang under
// a virtual display; on Windows and macOS a second spec reads the real clipboard back.
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const ETH_ADDRESS = 'https://address-copy-fixture.eth/docs/a%20b?q=1&r=2#top'
const ETH_LINK = 'https://address-copy-fixture.eth.limo/docs/a%20b?q=1&amp;r=2#top'

let http: FixtureServer

beforeAll(async () => {
  http = await startServer((_request, response) => { html(response, '<!doctype html><title>Fixture</title><p>Fixture</p>') })
})

afterAll(async () => {
  await http.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

/** What the main process was asked to put on the clipboard: each call, with the formats it carried. */
interface Written { call: 'write' | 'writeText', formats: Record<string, string> }

/** Replaces both clipboard writes in the main process with a recorder that never reaches the machine. Like the real
 * methods, both are async and resolve once the write is done. */
async function recordClipboard (app: App): Promise<void> {
  await app.evaluate(({ clipboard }) => {
    const g = globalThis as unknown as { __written: Array<Promise<Written>> }
    g.__written = []
    const target = clipboard as unknown as { write: (items: Array<{ types: string[], getType: (type: string) => Promise<Blob> }>) => Promise<void>, writeText: (text: string) => Promise<void> }
    target.writeText = async (text) => { g.__written.push(Promise.resolve({ call: 'writeText', formats: { 'text/plain': text } })) }
    target.write = async (items) => {
      const formats: Record<string, string> = {}
      for (const item of items) for (const type of item.types) formats[type] = await (await item.getType(type)).text()
      g.__written.push(Promise.resolve({ call: 'write', formats } as Written))
    }
  })
}

const written = async (app: App): Promise<Written[]> =>
  await app.evaluate(async () => await Promise.all((globalThis as unknown as { __written: Array<Promise<unknown>> }).__written)) as Written[]

const writtenCount = async (app: App): Promise<number> =>
  await app.evaluate(() => (globalThis as unknown as { __written: unknown[] }).__written.length)

async function visit (chrome: Page, address: string): Promise<void> {
  await clickAddressBarRetrying(chrome, address)
  expect((await waitForTab(chrome, { address })).ok).toBe(true)
}

const inputValue = async (chrome: Page): Promise<string> => await chrome.locator('#address').inputValue()

/** Puts the real input in the state a first click on the bar leaves it in: focused, with all of its text selected. */
async function selectAll (chrome: Page): Promise<void> {
  await chrome.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#address') as HTMLInputElement
    input.focus()
    input.select()
  })
}

/** A copy event on the field as the page sees it, without the browser's own copy that follows one: whether the field stopped it. */
async function copyEventPrevented (chrome: Page, range?: [number, number]): Promise<boolean> {
  return await chrome.evaluate((part) => {
    const input = document.querySelector<HTMLInputElement>('#address') as HTMLInputElement
    input.focus()
    if (part === undefined) input.select()
    else input.setSelectionRange(part[0], part[1])
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    return event.defaultPrevented
  }, range)
}

/** The chrome view's own Copy, which the address field's right-click menu runs. */
async function copyFromMenu (app: App): Promise<void> {
  await app.evaluate(({ webContents }) => {
    const chrome = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/renderer/index.html'))
    if (chrome === undefined) throw new Error('no chrome view')
    chrome.copy()
  })
}

it('writes a .eth address as its own text and as a link to its eth.limo form, from the keyboard, the field\'s menu and a copy event', async () => {
  const { app, chrome } = await launchShell()
  try {
    await recordClipboard(app)
    await visit(chrome, ETH_ADDRESS)
    const shown = await inputValue(chrome)
    expect(shown).toContain('address-copy-fixture.eth')
    const clip = { call: 'write', formats: { 'text/plain': shown, 'text/html': `<a href="${ETH_LINK}">${shown.replace(/&/g, '&amp;')}</a>` } }

    // A first click selects the whole address; Ctrl+C is then the browser's own shortcut for the field.
    await chrome.click('#address')
    await chrome.keyboard.press('ControlOrMeta+C')
    expect(await waitFor(async () => (await writtenCount(app)) === 1)).toBe(true)
    expect(await written(app)).toEqual([clip])

    await selectAll(chrome)
    await copyFromMenu(app)
    expect(await waitFor(async () => (await writtenCount(app)) === 2)).toBe(true)
    expect((await written(app)).at(-1)).toEqual(clip)

    expect(await copyEventPrevented(chrome)).toBe(true)
    expect(await waitFor(async () => (await writtenCount(app)) === 3)).toBe(true)
    expect((await written(app)).at(-1)).toEqual(clip)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('leaves a copy of part of the address to the browser, and writes an ordinary web address as plain text', async () => {
  const { app, chrome } = await launchShell()
  try {
    await recordClipboard(app)
    await visit(chrome, ETH_ADDRESS)
    expect(await copyEventPrevented(chrome, [0, 8])).toBe(false)
    expect(await copyEventPrevented(chrome, [3, (await inputValue(chrome)).length])).toBe(false)
    await delay(ABSENCE_SETTLE_MS)
    expect(await writtenCount(app)).toBe(0)

    const address = `${http.origin}/plain?a=1&b=2`
    await visit(chrome, address)
    expect(await inputValue(chrome)).toBe(address)
    expect(await copyEventPrevented(chrome)).toBe(true)
    expect(await waitFor(async () => (await writtenCount(app)) === 1)).toBe(true)
    expect(await written(app)).toEqual([{ call: 'writeText', formats: { 'text/plain': address } }])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

// Skipped on Linux: a main-process clipboard read can hang under the virtual display the e2e suite runs in, so the
// recorded writes above are what proves it there.
it.skipIf(process.platform === 'linux')('puts both formats on the real clipboard of this system when the whole address is copied', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(chrome, ETH_ADDRESS)
    const shown = await inputValue(chrome)
    await chrome.click('#address')
    await chrome.keyboard.press('ControlOrMeta+C')
    const read = async (): Promise<{ text: string, html: string }> => await app.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read()
      const one = async (type: string): Promise<string> => {
        const item = items.find((candidate) => candidate.types.includes(type))
        return item === undefined ? '' : await ((await item.getType(type)) as Blob).text()
      }
      return { text: await one('text/plain'), html: await one('text/html') }
    })
    expect(await waitFor(async () => (await read()).text === shown)).toBe(true)
    const clip = await read()
    expect(clip.text).toBe(shown)
    expect(clip.html).toContain(`<a href="${ETH_LINK}">`)
    expect(clip.html).toContain(`>${shown.replace(/&/g, '&amp;')}</a>`)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
