// What a page that bundles the `electron` shim can count on from `ipcRenderer.sendSync` and `powerSaveBlocker`
// (catalogue: Page platform and storage): a synchronous call answers with the `returnValue` a listener set, and
// refuses by name when nothing answered; a started blocker asks the page's own `navigator.wakeLock` for a screen
// lock, which the browser grants, holds it while any blocker is started, and releases it with the last stop.
// Everything happens inside the page: no system power call and no file is involved.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-electron-ipc-power.test.ts
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import type { Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HTML = 'text/html; charset=utf-8'
const JS = 'text/javascript'
// A registered app's own policy admits no inline script: the page is a file, and the shim bundle comes second.
const PAGE = '<!doctype html><title>ipc and power</title><body><script src="/shim.js"></script></body>'
// What an app's bundler makes of `import { ipcMain, ipcRenderer, powerSaveBlocker } from 'electron'`, and a page that uses them.
// The page's own wake lock is wrapped to record what the shim asked for and what the browser answered.
const SHIM_ENTRY = `import { ipcMain, ipcRenderer, powerSaveBlocker } from './src/shim-electron/index.js'
type Sentinel = { released: boolean }
const wake = { requests: [] as string[], outcomes: [] as string[], sentinels: [] as Sentinel[] }
const real = navigator.wakeLock?.request?.bind(navigator.wakeLock)
if (real !== undefined) {
  Object.defineProperty(navigator.wakeLock, 'request', { configurable: true, value: async (type: string) => {
    wake.requests.push(type)
    try {
      const sentinel = await real(type as 'screen')
      wake.outcomes.push('granted')
      wake.sentinels.push(sentinel)
      return sentinel
    } catch (error) {
      wake.outcomes.push('refused:' + (error as Error).name)
      throw error
    }
  } })
}
const outcome = (run: () => unknown): string => {
  try { return 'returned:' + JSON.stringify(run()) } catch (error) { return 'ERR:' + (error as Error).name + ':' + (error as { reason?: string }).reason }
}
ipcMain.on('probe-get', (event, key: string) => { event.returnValue = { key, value: 42 } })
ipcMain.on('probe-empty', (event) => { event.returnValue = undefined })
ipcMain.on('probe-silent', () => {})
ipcMain.on('probe-late', (async (event: { returnValue: unknown }) => { await Promise.resolve(); event.returnValue = 1 }) as never)
;(window as unknown as { shim: unknown }).shim = {
  sendSync: (channel: string, ...args: unknown[]) => outcome(() => ipcRenderer.sendSync(channel, ...args)),
  sendSyncEmpty: () => String(ipcRenderer.sendSync('probe-empty')),
  chain: () => ipcMain.on('a', () => {}).on('b', () => {}) === ipcMain,
  start: (type: string) => outcome(() => powerSaveBlocker.start(type as 'prevent-display-sleep')),
  startBoth: () => [powerSaveBlocker.start('prevent-display-sleep'), powerSaveBlocker.start('prevent-app-suspension')],
  stop: (id: number) => powerSaveBlocker.stop(id),
  isStarted: (id: number) => powerSaveBlocker.isStarted(id),
  wake: () => ({ requests: wake.requests, outcomes: wake.outcomes, released: wake.sentinels.map((s) => s.released), visibility: document.visibilityState })
}`

let app$: AppServer
beforeAll(async () => {
  const bundle = (await esbuild.build({
    stdin: { contents: SHIM_ENTRY, resolveDir: REPO_ROOT, loader: 'ts', sourcefile: 'shim-electron-entry.ts' },
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, logLevel: 'silent'
  })).outputFiles[0]?.text ?? ''
  app$ = await startAppServer({ '/': { type: HTML, body: PAGE }, '/shim.js': { type: JS, body: bundle } })
})
afterAll(async () => {
  await app$.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const shimCall = async (view: Page, call: string, ...args: unknown[]): Promise<unknown> =>
  await view.evaluate(([name, values]) => (window as unknown as { shim: Record<string, (...a: unknown[]) => unknown> }).shim[name as string]?.(...(values as unknown[])), [call, args] as const)
interface Wake { requests: string[], outcomes: string[], released: boolean[], visibility: string }
const wakeState = async (view: Page): Promise<Wake> => await shimCall(view, 'wake') as Wake

it('[app:electron-ipc-send-sync-answers-from-the-listener] ipcRenderer.sendSync answers with the returnValue a listener set, and refuses by name when nothing answered', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('electron sendSync', async (check) => {
      await grantApp(app, app$.origin, appManifest('electron-ipc', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${app$.origin}/`)

      check('[app:electron-ipc-send-sync-answers-from-the-listener] the listener\'s returnValue comes back from the call, with the arguments passed', await shimCall(view, 'sendSync', 'probe-get', 'k') === 'returned:{"key":"k","value":42}')
      check('[app:electron-ipc-send-sync-answers-from-the-listener] a returnValue explicitly set to undefined is an answer', await shimCall(view, 'sendSyncEmpty') === 'undefined')
      check('[app:electron-ipc-send-sync-answers-from-the-listener] a channel nobody listens on refuses with invalid-usage', await shimCall(view, 'sendSync', 'nobody') === 'ERR:ElectronShimError:invalid-usage')
      check('[app:electron-ipc-send-sync-answers-from-the-listener] so does a listener that never set returnValue', await shimCall(view, 'sendSync', 'probe-silent') === 'ERR:ElectronShimError:invalid-usage')
      check('[app:electron-ipc-send-sync-answers-from-the-listener] and an async listener, which cannot answer a synchronous call', await shimCall(view, 'sendSync', 'probe-late') === 'ERR:ElectronShimError:invalid-usage')
      check('[app:electron-ipc-send-sync-answers-from-the-listener] listener registration returns the emitter, so calls chain', await shimCall(view, 'chain') === true)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('[app:electron-power-save-blocker-holds-a-wake-lock] powerSaveBlocker asks the page for one screen wake lock while any blocker is started, releases it with the last stop, and never throws', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('electron powerSaveBlocker', async (check) => {
      await grantApp(app, app$.origin, appManifest('electron-power', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${app$.origin}/`)

      // Both in one task, so a browser that refuses at once cannot make the second start a new request.
      const [first, second] = await shimCall(view, 'startBoth') as [number, number]
      check('[app:electron-power-save-blocker-holds-a-wake-lock] start returns an id for each blocker and does not throw', Number.isInteger(first) && Number.isInteger(second) && second > first, JSON.stringify({ first, second }))
      check('[app:electron-power-save-blocker-holds-a-wake-lock] the page was asked for exactly one screen wake lock, whichever types were started', await waitFor(async () => (await wakeState(view)).outcomes.length === 1) && JSON.stringify((await wakeState(view)).requests) === '["screen"]', JSON.stringify(await wakeState(view)))
      check('[app:electron-power-save-blocker-holds-a-wake-lock] isStarted reflects the app\'s ids', await shimCall(view, 'isStarted', first) === true && await shimCall(view, 'isStarted', second) === true && await shimCall(view, 'isStarted', 9999) === false)

      check('[app:electron-power-save-blocker-holds-a-wake-lock] the browser granted the lock the shim asked for', (await wakeState(view)).outcomes[0] === 'granted', JSON.stringify(await wakeState(view)))
      check('[app:electron-power-save-blocker-holds-a-wake-lock] stopping one of two blockers keeps the lock', await shimCall(view, 'stop', first) === true && (await wakeState(view)).released[0] === false)
      check('[app:electron-power-save-blocker-holds-a-wake-lock] stopping the last releases it', await shimCall(view, 'stop', second) === true && await waitFor(async () => (await wakeState(view)).released[0] === true))
      check('[app:electron-power-save-blocker-holds-a-wake-lock] a stopped id is no longer started, and stopping it again answers false', await shimCall(view, 'isStarted', first) === false && await shimCall(view, 'stop', first) === false)
      check('[app:electron-power-save-blocker-holds-a-wake-lock] a type Electron does not know refuses with invalid-usage', await shimCall(view, 'start', 'prevent-everything') === 'ERR:ElectronShimError:invalid-usage')
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
