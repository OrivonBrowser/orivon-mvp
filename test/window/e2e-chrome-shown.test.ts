// The chrome stays shown, and keeps drawing, when an opaque overlay as wide as the page area is up over it. The loading
// screen of an `ipfs://` page is such an overlay. After a resize, Chromium counted the chrome view as covered by it: the
// chrome read `hidden`, its animations stopped (the tab strip's loading spinner among them) and only a tab switch, which
// hides the cover, brought it back. A question over the loading screen (the first visit to an app asks while its page
// still loads) left the chrome hidden in a window never resized too, and so did any bar or popup shown after the cover
// (src/main/overlays/README.md section An overlay as wide as the window can leave the chrome hidden).
//
// Playwright keeps every page it drives visible, so these specs launch the shell with nothing driving the pages and read
// the chrome through the main process's own inspector (./chrome-shown-support.ts). The window is resized with setBounds,
// which is the resize a maximize or a fullscreen makes; under the headless display no window manager is needed for it.
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { withDeclaredTree } from '../web3/first-visit-support.js'
import { expectChromeShown, openTab, resizeOnce, sleep, SHOWN_OVERLAYS, toggleOverlay, turnedHidden, untilShown, watchChrome, withShell } from './chrome-shown-support.js'

const BLOCK_DELAY_MS = 6_000
/** Each block of the app's site is answered this late, so the question comes a second or two in. */
const QUESTION_BLOCK_DELAY_MS = 1_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('keeps the chrome shown while a full-width overlay is up over a resized window', async () => {
  const site = { 'index.html': '<!doctype html><meta charset="utf-8"><title>chrome shown fixture</title><body>the page</body>' }
  await withShell({ site }, { blockDelayMs: BLOCK_DELAY_MS }, async (main, gateway) => {
    await resizeOnce(main)
    await watchChrome(main)

    await openTab(main, `ipfs://${gateway.roots['site']!}`)
    await untilShown(main, ['loading-screen'], 30)

    // The wrong answer comes within a few frames of the attach and lasts until the cover goes, so a second of settling is enough.
    await sleep(1_000)
    await expectChromeShown(main, ['loading-screen'])
    expect(await turnedHidden(main), 'the chrome page turned hidden').toBe(0)
  })
}, 180_000)

/** An app that asks for a grant, so its first visit puts a question over the loading screen. Its page waits on a script the test releases: the loading screen stays up for as long as the test reads the chrome, whatever else the shell fetches meanwhile. */
const slowApp = (): Record<string, string> => ({
  'index.html': '<!doctype html><meta charset="utf-8"><title>Slow app</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>Slow app<script src="late.js"></script></body>',
  'late.js': '/* the page is not ready until this has arrived */',
  '.well-known/orivon.json': JSON.stringify({
    orivonApiVersion: 0, id: 'chrome.shown.slow.app', name: 'Slow app', version: '1.0.0', entry: 'index.html', assets: ['late.js'], capabilities: { trust: { score: true } }
  })
})

const WINDOWS: Array<[string, boolean]> = [['a window never resized', false], ['a resized window', true]]

it.each(WINDOWS)('keeps the chrome shown while the first visit to an app asks its question over the loading screen, in %s', async (_name, resize) => {
  const sites = { slowApp: await withDeclaredTree(slowApp()) }
  await withShell(sites, { blockDelayMs: QUESTION_BLOCK_DELAY_MS }, async (main, gateway) => {
    const release = gateway.hold('slowApp', 'late.js')
    if (resize) await resizeOnce(main)
    await watchChrome(main)

    await openTab(main, `ipfs://${gateway.roots['slowApp']!}`)
    await untilShown(main, ['question', 'loading-screen'])

    // The cover stays until the page's script is released.
    await sleep(500)
    await expectChromeShown(main, ['question', 'loading-screen'])
    expect(await turnedHidden(main), 'the chrome page turned hidden').toBe(0)
    release()
  })
}, 180_000)

it.each(WINDOWS)('keeps the chrome shown when a bar and a popup are shown over the question and the loading screen, in %s', async (_name, resize) => {
  const sites = { slowApp: await withDeclaredTree(slowApp()) }
  await withShell(sites, { blockDelayMs: QUESTION_BLOCK_DELAY_MS }, async (main, gateway) => {
    const release = gateway.hold('slowApp', 'late.js')
    if (resize) await resizeOnce(main)
    await watchChrome(main)

    await openTab(main, `ipfs://${gateway.roots['slowApp']!}`)
    await untilShown(main, ['question', 'loading-screen'])
    await sleep(1_000)

    // Each one is attached over the cover, as a link's address under the pointer or a menu is while a page loads.
    await toggleOverlay(main, 'find')
    await untilShown(main, ['find'], 10)
    await sleep(500)
    await toggleOverlay(main, 'tab-search')
    await untilShown(main, ['tab-search'], 10)
    await sleep(500)

    expect(await turnedHidden(main), 'the chrome page turned hidden').toBe(0)
    await expectChromeShown(main, ['question', 'loading-screen'])
    expect(await main.evaluate(SHOWN_OVERLAYS)).toEqual(expect.arrayContaining(['find']))
    release()
  })
}, 180_000)
