// Proves src/main/shell/shell-session.ts actually reaches the views it was
// built for: the chrome view is on session.fromPartition('persist:orivon-
// shell'), never session.defaultSession -- the partition an extension will
// load into and act on <all_urls> in -- while an ordinary tab stays on the
// default session. Read from the MAIN process (app.evaluate), the only
// place a WebContents' real `.session` object is observable
// (e2e-session-partitions.test.ts's header says why).
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'
import { closeElectronApp, runPhase } from './e2e-helpers.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 30_000

it('the chrome view runs in the dedicated shell partition, never the default session, and an ordinary tab stays on the default session', async () => {
  let app: Awaited<ReturnType<typeof launchElectron>> | undefined
  try {
    app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })

    await runPhase('shell view partition isolation', async (check) => {
      const windowsReady = await waitFor(() => (app as NonNullable<typeof app>).windows().length === 2)
      check('the shell reaches its launch-time window count', windowsReady)

      const chrome = findChrome(app as NonNullable<typeof app>)

      // A genuinely new tab, so the "ordinary tab" half is not just the
      // launch-time dashboard tab reused.
      await chrome.click('#new-tab')
      const idsAfterNewTab = await waitFor(async () => (await tabIds(chrome)).length === 2)
      check('opening a new tab makes two tabs', idsAfterNewTab)
      const ids = await tabIds(chrome)
      const newTabActive = await waitForTab(chrome, { activeId: ids[1] })
      check('the new tab becomes active', newTabActive.ok)

      const result = await (app as NonNullable<typeof app>).evaluate(({ webContents, session }) => {
        const all = webContents.getAllWebContents()
        const chromeWc = all.find((wc) => wc.getURL().endsWith('/renderer/index.html'))
        const tabWc = all.find((wc) => wc.getURL().endsWith('/renderer/newtab/index.html'))
        if (chromeWc === undefined || tabWc === undefined) return { found: false as const }
        return {
          found: true as const,
          chromeOnShellPartition: chromeWc.session === session.fromPartition('persist:orivon-shell'),
          chromeOffDefault: chromeWc.session !== session.defaultSession,
          tabOnDefault: tabWc.session === session.defaultSession
        }
      })

      check('both the chrome view and an ordinary tab are found in the main process', result.found)
      if (result.found) {
        check('the chrome view\'s webContents.session is session.fromPartition(\'persist:orivon-shell\')', result.chromeOnShellPartition)
        check('the chrome view is NOT on session.defaultSession', result.chromeOffDefault)
        check('an ordinary tab IS on session.defaultSession', result.tabOnDefault)
      }
    })
  } finally {
    if (app !== undefined) await closeElectronApp(app)
  }
}, TEST_TIMEOUT_MS)
