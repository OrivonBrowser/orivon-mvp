// An app's screen sharing (catalogue: Consent and grants): `media.screen` declared and not yet held is asked in the
// tab's panel, then Orivon's picker opens; an app that does not declare it is refused with no picker. The Electron
// shim's `desktopCapturer.getSources` runs that same picker and serves the one source it returns through the legacy
// `chromeMediaSource: 'desktop'` call. The picker is the stand-in the e2e build offers (the real one is proved in
// test/sites/e2e-screen-share.test.ts); the gate and the grant are the real ones.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-screen-share.test.ts
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HTML = 'text/html; charset=utf-8'
const JS = 'text/javascript'
// A registered app's own policy admits no inline script and no eval: the page is a file, and the spec sets what a click does with a real function.
// The shim reads window.orivon when it loads, and writes into the `__r` the app's own script made, so it comes second.
const PAGE = '<!doctype html><title>screen</title><body><button id="go">go</button><script src="/app.js"></script><script src="/shim.js"></script></body>'
const APP_JS = `
window.__r = {}
const settle = (key, promise) => promise.then((value) => { window.__r[key] = value }, (error) => { window.__r[key] = 'ERR:' + error.name })
window.share = (key, options) => settle(key, navigator.mediaDevices.getDisplayMedia(options).then((stream) => {
  const track = stream.getVideoTracks()[0]
  const state = { tracks: stream.getTracks().length, state: track.readyState, surface: track.getSettings().displaySurface }
  for (const each of stream.getTracks()) each.stop()
  return state
}))
window.__next = () => {}
document.getElementById('go').addEventListener('click', () => window.__next())
`
// What an app's bundler makes of `import { desktopCapturer } from 'electron'`: the shim, and a page that uses it.
const SHIM_ENTRY = `import { desktopCapturer } from './src/shim-electron/index.js'
const settle = (key: string, promise: Promise<unknown>): void => {
  void promise.then((value) => { window.__r[key] = value }, (error: Error) => { window.__r[key] = 'ERR:' + error.name })
}
const legacy = async (id: string): Promise<unknown> => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id } } } as unknown as MediaStreamConstraints)
  const track = stream.getVideoTracks()[0]
  const state = { tracks: stream.getTracks().length, video: track?.readyState }
  for (const each of stream.getTracks()) each.stop()
  return state
}
declare global { interface Window { __r: Record<string, unknown>, shim: unknown } }
window.shim = {
  sources: (key: string, options: unknown) => { settle(key, desktopCapturer.getSources(options as never).then(async (sources) => {
    const [source] = sources
    const thumbnail = source?.thumbnail
    return {
      count: sources.length,
      id: source?.id,
      name: source?.name,
      displayId: source?.display_id,
      appIcon: source?.appIcon,
      empty: thumbnail?.isEmpty(),
      size: thumbnail?.getSize(),
      png: thumbnail?.toDataURL().startsWith('data:image/png') === true,
      pngBytes: (thumbnail?.toPNG().length ?? 0) > 0
    }
  })) },
  legacy: (key: string, id: string) => { settle(key, legacy(id)) }
}`

let declared: AppServer
let undeclared: AppServer
let shimBundle = ''
beforeAll(async () => {
  shimBundle = (await esbuild.build({
    stdin: { contents: SHIM_ENTRY, resolveDir: REPO_ROOT, loader: 'ts', sourcefile: 'shim-electron-entry.ts' },
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, logLevel: 'silent'
  })).outputFiles[0]?.text ?? ''
  const routes = { '/': { type: HTML, body: PAGE }, '/app.js': { type: JS, body: APP_JS }, '/shim.js': { type: JS, body: shimBundle } }
  declared = await startAppServer(routes)
  undeclared = await startAppServer(routes)
})
afterAll(async () => {
  await declared.close()
  await undeclared.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Hook { use: (mode: unknown) => void, calls: Array<{ origin: string, isApp: boolean }>, reset: () => void }
const hookReady = async (app: ElectronApplication): Promise<boolean> =>
  await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __orivonDevDisplayChooser?: unknown }).__orivonDevDisplayChooser)) !== undefined)
const useChooser = async (app: ElectronApplication, mode: unknown): Promise<void> => { await app.evaluate((_electron, m) => { (globalThis as unknown as { __orivonDevDisplayChooser: Hook }).__orivonDevDisplayChooser.use(m) }, mode) }
const chooserCalls = async (app: ElectronApplication): Promise<Array<{ origin: string, isApp: boolean }>> =>
  await app.evaluate(() => (globalThis as unknown as { __orivonDevDisplayChooser: Hook }).__orivonDevDisplayChooser.calls.map(({ origin, isApp }) => ({ origin, isApp })))

const result = async (view: Page, key: string, timeoutMs = 20_000): Promise<unknown> => {
  let last: unknown
  await waitFor(async () => { last = await view.evaluate((k) => (window as unknown as { __r: Record<string, unknown> }).__r[k], key); return last !== undefined }, timeoutMs)
  return last
}
/** Sets what the click does and presses it as the person does, so the page has the transient activation a share needs. */
const clickDoing = async (view: Page, call: string, ...args: unknown[]): Promise<void> => {
  await view.evaluate(([path, values]) => {
    const parts = (path as string).split('.')
    const target = parts.slice(0, -1).reduce<Record<string, unknown>>((object, key) => object[key] as Record<string, unknown>, window as unknown as Record<string, unknown>)
    ;(window as unknown as { __next: () => void }).__next = () => { (target[parts.at(-1) as string] as (...a: unknown[]) => void)(...(values as unknown[])) }
  }, [call, args] as const)
  await view.click('#go')
}
const text = (question: { title: string, message: string, detail: string }): string => `${question.title} ${question.message} ${question.detail}`

const SCREEN_MANIFEST = { fs: { quotaBytes: 1024 }, media: { screen: true as const } }

it('[app:app-screen-declared-shows-the-picker] a declared media.screen is asked in the tab\'s panel, then Orivon\'s picker opens and the share goes to the app', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('declared app screen', async (check) => {
      await stubNativeDialogs(app)
      expect(await hookReady(app)).toBe(true)
      await useChooser(app, { kind: 'screen' })
      await grantApp(app, declared.origin, appManifest('screen-declared', SCREEN_MANIFEST), [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${declared.origin}/`)

      await clickDoing(view, 'share', 'first', { video: true })
      const question = await readQuestion(await waitQuestion(app))
      check('[app:app-screen-declared-shows-the-picker] the first share raises a question in the panel that names the screen', /screen/i.test(text(question)) && question.buttons.includes('Allow'), JSON.stringify(question))
      check('[app:app-screen-declared-shows-the-picker] the picker has not opened while the question is open', (await chooserCalls(app)).length === 0)
      await answerQuestion(app, 'Allow')
      const first = await result(view, 'first')
      check('[app:app-screen-declared-shows-the-picker] on Allow the picker opened for the app and the page got a live video track', JSON.stringify(first) === JSON.stringify({ tracks: 1, state: 'live', surface: 'monitor' }) && (await chooserCalls(app)).length === 1, JSON.stringify(first))
      const asked = (await chooserCalls(app))[0]
      check('[app:app-screen-declared-shows-the-picker] the picker was told it serves an app, by origin', asked?.isApp === true && asked.origin === declared.origin, JSON.stringify(asked))

      await clickDoing(view, 'share', 'second', { video: true })
      const second = await result(view, 'second')
      check('[app:app-screen-declared-shows-the-picker] the next share shows the picker again with no second question', (second as { tracks?: number }).tracks === 1 && (await chooserCalls(app)).length === 2 && await questionGone(app), JSON.stringify(second))
      check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 3)

it('[app:app-screen-undeclared-is-refused] an app that does not declare media.screen is refused with no question and no picker', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('undeclared app screen', async (check) => {
      await stubNativeDialogs(app)
      expect(await hookReady(app)).toBe(true)
      await useChooser(app, { kind: 'screen' })
      await grantApp(app, undeclared.origin, appManifest('screen-undeclared', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${undeclared.origin}/`)
      await clickDoing(view, 'share', 'refused', { video: true })
      check('[app:app-screen-undeclared-is-refused] the page gets NotAllowedError', await result(view, 'refused') === 'ERR:NotAllowedError')
      check('[app:app-screen-undeclared-is-refused] the picker was never opened and no question was raised', (await chooserCalls(app)).length === 0 && await questionGone(app))
      check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)

it('[app:electron-desktop-capturer-serves-the-picked-source] the shim\'s desktopCapturer.getSources runs the picker and returns the one source, which its chromeMediaSource getUserMedia turns into that stream once', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('electron desktopCapturer', async (check) => {
      await stubNativeDialogs(app)
      expect(await hookReady(app)).toBe(true)
      await useChooser(app, { kind: 'screen' })
      await grantApp(app, declared.origin, appManifest('shim-capturer', SCREEN_MANIFEST), [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${declared.origin}/`)

      await clickDoing(view, 'shim.sources', 'sources', { types: ['screen'], thumbnailSize: { width: 320, height: 180 } })
      await answerQuestion(app, 'Allow')
      const sources = await result(view, 'sources') as { count: number, id: string, name: string, displayId: string, appIcon: unknown, empty: boolean, size: { width: number, height: number }, png: boolean, pngBytes: boolean }
      check('[app:electron-desktop-capturer-serves-the-picked-source] getSources resolves exactly one source, named for what was picked, with the Electron shape', sources.count === 1 && /^orivon-shared:/.test(sources.id) && sources.name.length > 0 && sources.displayId === '' && sources.appIcon === null, JSON.stringify(sources))
      check('[app:electron-desktop-capturer-serves-the-picked-source] its thumbnail is a real frame within thumbnailSize', !sources.empty && sources.size.width > 0 && sources.size.width <= 320 && sources.size.height <= 180 && sources.png && sources.pngBytes, JSON.stringify(sources))
      const calls = await chooserCalls(app)
      check('[app:electron-desktop-capturer-serves-the-picked-source] the picker that ran was Orivon\'s, opened once for the app', calls.length === 1 && calls[0]?.isApp === true, JSON.stringify(calls))

      await clickDoing(view, 'shim.legacy', 'refusedId', 'screen:0:0')
      check('[app:electron-desktop-capturer-serves-the-picked-source] an id the picker did not produce is refused with NotAllowedError', await result(view, 'refusedId') === 'ERR:NotAllowedError')
      await clickDoing(view, 'shim.legacy', 'served', sources.id)
      check('[app:electron-desktop-capturer-serves-the-picked-source] the picked id gets the stream it stands for', JSON.stringify(await result(view, 'served')) === JSON.stringify({ tracks: 1, video: 'live' }), JSON.stringify(await result(view, 'served')))
      await clickDoing(view, 'shim.legacy', 'again', sources.id)
      check('[app:electron-desktop-capturer-serves-the-picked-source] and only once', await result(view, 'again') === 'ERR:NotAllowedError')
      check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 3)
