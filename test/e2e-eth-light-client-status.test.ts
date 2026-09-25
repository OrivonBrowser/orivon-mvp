// The Settings panel's "Ethereum light client" section, live: it says the
// client is off when a run switches it off, that the verifier is not running
// when its process dies, and recovers once the shell restarts it; and, with
// the client on but every beacon API unreachable, it says it failed and why.
// Hermetic: HERMETIC_RESOLVER makes every mainnet name unresolvable, which is
// what forces the failure without contacting anything.
import { afterAll, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, closeElectronApp, runPhase, waitForAddressBarStable } from './e2e-helpers.js'
import type { ElectronApplication, Page } from 'playwright'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openSettings (app: ElectronApplication): Promise<Page> {
  await waitFor(() => app.windows().length === 2)
  const chrome = findChrome(app)
  await waitForAddressBarStable(chrome)
  await chrome.click('#permissions-btn')
  let panel: Page | undefined
  await waitFor(() => { panel = app.windows().find((w) => w.url().endsWith('/renderer/settings/index.html')); return panel !== undefined })
  if (panel === undefined) throw new Error('the settings panel did not open')
  return panel
}

async function lightClient (panel: Page): Promise<{ state: string, summary: string }> {
  return await evaluateRetrying(panel, () => ({
    state: document.querySelector('.light-client-state')?.textContent ?? '',
    summary: document.querySelector('.light-client-summary')?.textContent ?? ''
  }))
}

async function verifierPid (app: ElectronApplication): Promise<number | undefined> {
  return await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'Orivon .eth verifier')?.pid)
}

it('shows the light client off, down when its process dies, and back once it restarts', async () => {
  await runPhase('light-client-off', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
    try {
      const panel = await openSettings(app)
      const off = await waitFor(async () => (await lightClient(panel)).state === 'Off', 15_000)
      check(`switched off for the test run, Settings says Off (${JSON.stringify(await lightClient(panel))})`, off)

      const pidReady = await waitFor(async () => await verifierPid(app) !== undefined, 15_000)
      const pid = await verifierPid(app)
      check(`the verifier host is running as a utility process (pid ${String(pid)})`, pidReady && pid !== undefined)
      if (pid === undefined) throw new Error('no verifier host process found')
      process.kill(pid, 'SIGKILL')
      const down = await waitFor(async () => (await lightClient(panel)).state === 'Not running', 10_000)
      check(`killing it shows Not running, pushed while the panel is open (${JSON.stringify(await lightClient(panel))})`, down)
      const back = await waitFor(async () => (await lightClient(panel)).state === 'Off' && await verifierPid(app) !== undefined, 15_000)
      check('the shell restarts it, and Settings recovers', back)
      expect([off, down, back]).toEqual([true, true, true])
    } finally {
      await closeElectronApp(app, APP_CLOSE_RACE_MS)
    }
  })
}, 120_000)

/**
 * A checkpoint an hour old in the test's own profile, so the light client
 * starts, and fails, however long ago the release's checkpoint was taken.
 * Its root is never checked against anything: no beacon API is reachable.
 */
async function seedFreshCheckpoint (profile: string): Promise<void> {
  await mkdir(join(profile, 'verifier'), { recursive: true })
  await writeFile(join(profile, 'verifier', 'checkpoint.json'), JSON.stringify({ root: `0x${'1'.repeat(64)}`, timestamp: Math.floor(Date.now() / 1000) - 3600 }))
}

it('shows the light client failed, and why, when no beacon API can be reached', async () => {
  await runPhase('light-client-failed', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_ETH_LIGHT_CLIENT: 'on' }, seedProfile: seedFreshCheckpoint })
    try {
      const panel = await openSettings(app)
      const failed = await waitFor(async () => (await lightClient(panel)).state === 'Failed', 45_000)
      const shown = await lightClient(panel)
      check(`Settings says Failed with a reason and a retry (${JSON.stringify(shown)})`, failed && /Failed: .+\. Trying again/.test(shown.summary))
      expect(failed).toBe(true)
    } finally {
      await closeElectronApp(app, APP_CLOSE_RACE_MS)
    }
  })
}, 120_000)
