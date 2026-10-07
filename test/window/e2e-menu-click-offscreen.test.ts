// A menu item's click survives an offscreen web contents in the process, as an app's child host is. Electron runs
// every native menu click through `Menu._executeCommand`, which asks `webContents.getFocusedWebContents()`; asked of
// an offscreen contents, Electron's own lookup kills the main process (src/main/focus/focused-contents-guard.ts).
//
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/window/e2e-menu-click-offscreen.test.ts
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('runs a menu click while an offscreen web contents is loaded', async () => {
  const { app } = await launchShell()
  try {
    const loaded = await app.evaluate(async ({ WebContentsView }) => {
      const view = new WebContentsView({ webPreferences: { offscreen: true, sandbox: true } })
      ;(globalThis as { __offscreenProbe?: unknown }).__offscreenProbe = view
      await view.webContents.loadURL('data:text/html,<title>host</title>')
      return view.webContents.getType()
    })
    expect(loaded).toBe('offscreen')

    const clicked = await app.evaluate(({ Menu }) => {
      let ran = false
      const menu = Menu.buildFromTemplate([{ label: 'Copy Link', click: () => { ran = true } }])
      const internal = menu as unknown as { commandsMap: Record<string, unknown>, _executeCommand: (event: object, id: number) => void }
      internal._executeCommand({}, Number(Object.keys(internal.commandsMap)[0]))
      return ran
    })
    expect(clicked).toBe(true)
    expect(await app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getType() ?? null)).not.toBe('offscreen')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
