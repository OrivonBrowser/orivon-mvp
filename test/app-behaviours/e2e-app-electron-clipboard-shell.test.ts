// What a page that bundles the `electron` shim can count on from `clipboard` and `shell` (catalogue: Page
// platform and storage): a synchronous `clipboard.readText()` inside a paste answers the pasted text and is
// empty outside one, and `shell.openExternal` opens the URL in a new Orivon tab, or meets the external-link
// question for a scheme the browser does not serve. The paste is dispatched with page-level events, never the
// system clipboard, and the OS opener is replaced in the main process, so nothing reaches the machine.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-electron-clipboard-shell.test.ts
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { answerQuestion, noNativeDialogs, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HTML = 'text/html; charset=utf-8'
const JS = 'text/javascript'
const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=probe'
// A registered app's own policy admits no inline script: the page is a file, and the shim bundle comes second.
const PAGE = '<!doctype html><title>clipboard</title><body><input id="field"><button id="go">go</button><script src="/shim.js"></script></body>'
// What an app's bundler makes of `import { clipboard, shell } from 'electron'`, and a page that uses them.
const SHIM_ENTRY = `import { clipboard, shell } from './src/shim-electron/index.js'
declare global { interface Window { __r: Record<string, unknown>, __next: () => void } }
window.__r = {}
window.__next = () => {}
document.getElementById('go')?.addEventListener('click', () => { window.__next() })
const settle = (key: string, promise: Promise<unknown>): void => {
  void promise.then((value) => { window.__r[key] = value === undefined ? 'resolved' : value }, (error: Error) => { window.__r[key] = 'ERR:' + error.name + ':' + (error as { reason?: string }).reason })
}
// What an app does with a paste: read it synchronously in its own listener.
document.addEventListener('paste', () => { window.__r['pasted'] = clipboard.readText() })
const copies: string[] = []
Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text: string) => { copies.push(text) }, configurable: true })
;(window as unknown as { shim: unknown }).shim = {
  readNow: () => clipboard.readText(),
  paste: (text: string) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    document.getElementById('field')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  },
  write: (text: string) => { window.__r['writeReturn'] = String(clipboard.writeText(text)); window.__r['copies'] = [...copies] },
  open: (key: string, url: unknown) => { settle(key, shell.openExternal(url as string)) },
  rawOpen: (url: string) => { window.open(url, '_blank', 'noopener,noreferrer') }
}`

let app$: AppServer
let target: AppServer
beforeAll(async () => {
  const bundle = (await esbuild.build({
    stdin: { contents: SHIM_ENTRY, resolveDir: REPO_ROOT, loader: 'ts', sourcefile: 'shim-electron-entry.ts' },
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, logLevel: 'silent'
  })).outputFiles[0]?.text ?? ''
  app$ = await startAppServer({ '/': { type: HTML, body: PAGE }, '/shim.js': { type: JS, body: bundle } })
  target = await startAppServer({ '/': { type: HTML, body: '<!doctype html><title>opened by shell</title><body>opened</body>' } })
})
afterAll(async () => {
  await app$.close()
  await target.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const shimCall = async (view: Page, call: string, ...args: unknown[]): Promise<unknown> =>
  await view.evaluate(([name, values]) => (window as unknown as { shim: Record<string, (...a: unknown[]) => unknown> }).shim[name as string]?.(...(values as unknown[])), [call, args] as const)
const read = async (view: Page, key: string): Promise<unknown> => await view.evaluate((k) => (window as unknown as { __r: Record<string, unknown> }).__r[k], key)
const result = async (view: Page, key: string): Promise<unknown> => {
  let last: unknown
  await waitFor(async () => { last = await read(view, key); return last !== undefined })
  return last
}
/** Sets what the next press of the page's button does, then presses it as the person does. */
const clickDoing = async (view: Page, call: string, ...args: unknown[]): Promise<void> => {
  await view.evaluate(([name, values]) => {
    ;(window as unknown as { __next: () => void }).__next = () => { (window as unknown as { shim: Record<string, (...a: unknown[]) => unknown> }).shim[name as string]?.(...(values as unknown[])) }
  }, [call, args] as const)
  await view.click('#go')
}

/** Replaces the OS opener in the main process and records what it was asked to open. */
async function stubOpener (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = (async (url: string) => { g.__opened.push(url) }) as typeof shell.openExternal
  })
}
const opened = async (app: ElectronApplication): Promise<string[]> => await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

it('[app:electron-clipboard-reads-the-pasted-text] clipboard.readText answers the text being pasted inside the paste event and an empty string outside one, and writeText returns undefined', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('electron clipboard', async (check) => {
      await grantApp(app, app$.origin, appManifest('electron-clipboard', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${app$.origin}/`)

      check('[app:electron-clipboard-reads-the-pasted-text] outside a paste readText is empty', await shimCall(view, 'readNow') === '')
      await shimCall(view, 'paste', 'magnet:?xt=urn:btih:abc')
      check('[app:electron-clipboard-reads-the-pasted-text] inside the app\'s own paste listener readText is the pasted text', await read(view, 'pasted') === 'magnet:?xt=urn:btih:abc', JSON.stringify(await read(view, 'pasted')))
      check('[app:electron-clipboard-reads-the-pasted-text] once the paste is over readText is empty again', await waitFor(async () => await shimCall(view, 'readNow') === ''))

      await shimCall(view, 'write', 'copied text')
      check('[app:electron-clipboard-reads-the-pasted-text] writeText returns undefined and hands the text to the browser clipboard', await read(view, 'writeReturn') === 'undefined' && JSON.stringify(await read(view, 'copies')) === JSON.stringify(['copied text']), JSON.stringify(await read(view, 'copies')))
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('[app:electron-shell-open-external-opens-a-tab] shell.openExternal opens an address in a new tab and rejects a value that is not an absolute URL', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('electron shell', async (check) => {
      await grantApp(app, app$.origin, appManifest('electron-shell', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${app$.origin}/`)
      const before = await tabIds(chrome)

      await clickDoing(view, 'open', 'web', `${target.origin}/`)
      const tab = await waitForTab(chrome, { address: `${target.origin}/` })
      const after = await tabIds(chrome)
      check('[app:electron-shell-open-external-opens-a-tab] an http address opens one new tab that shows it', tab.ok && after.length === before.length + 1, JSON.stringify({ before, after, info: tab.info }))
      check('[app:electron-shell-open-external-opens-a-tab] and the call resolved', await result(view, 'web') === 'resolved')

      await shimCall(view, 'open', 'bad', 'not a url')
      check('[app:electron-shell-open-external-opens-a-tab] a string that is not an address rejects with invalid-usage', await result(view, 'bad') === 'ERR:ElectronShimError:invalid-usage', JSON.stringify(await read(view, 'bad')))
      await shimCall(view, 'open', 'number', 5)
      check('[app:electron-shell-open-external-opens-a-tab] and so does a value that is not a string', await result(view, 'number') === 'ERR:ElectronShimError:invalid-usage')
      check('[app:electron-shell-open-external-opens-a-tab] and neither opened another tab', (await tabIds(chrome)).length === after.length)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('[app:window-open-external-address-asks] [app:electron-shell-open-external-opens-a-tab] a window.open of a magnet address, and shell.openExternal of one, raise the external-link question and leave no blank tab', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('window.open external address', async (check) => {
      await stubNativeDialogs(app)
      await stubOpener(app)
      await grantApp(app, app$.origin, appManifest('window-open-external', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${app$.origin}/`)
      const before = await tabIds(chrome)

      await clickDoing(view, 'rawOpen', MAGNET)
      const question = await readQuestion(await waitQuestion(app))
      check('[app:window-open-external-address-asks] the question names the scheme, the page that wants it and the address', /magnet/i.test(question.message) && question.detail === `${app$.origin} wants to open:\n${MAGNET}` && question.buttons.includes('Allow'), JSON.stringify(question))
      await answerQuestion(app, 'Cancel')
      await delay(ABSENCE_SETTLE_MS)
      check('[app:window-open-external-address-asks] Cancel hands nothing to the system', (await opened(app)).length === 0, JSON.stringify(await opened(app)))
      check('[app:window-open-external-address-asks] and no tab was opened', JSON.stringify(await tabIds(chrome)) === JSON.stringify(before), JSON.stringify(await tabIds(chrome)))

      await clickDoing(view, 'open', 'magnet', MAGNET)
      const second = await readQuestion(await waitQuestion(app))
      await answerQuestion(app, 'Allow')
      check('[app:electron-shell-open-external-opens-a-tab] shell.openExternal of a magnet address asks the same question, and Allow hands exactly that address to the system', await waitFor(async () => (await opened(app)).length === 1) && (await opened(app))[0] === MAGNET && second.detail.includes(MAGNET), JSON.stringify({ opened: await opened(app), second }))
      check('[app:electron-shell-open-external-opens-a-tab] and the call resolved with no tab opened', await result(view, 'magnet') === 'resolved' && JSON.stringify(await tabIds(chrome)) === JSON.stringify(before))
      check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)
