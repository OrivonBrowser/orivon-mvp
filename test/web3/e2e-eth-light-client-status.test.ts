// The Available networks popup's "Ethereum light client" card, live: it says the
// client is off, with its switch fixed, when a run switches it off; that the verifier is not running
// when its process dies, and recovers once the shell restarts it; and, with
// the client on but every beacon API unreachable, it says it failed and why.
// The verifier host runs only once a .eth address is needed, so each run types one.
// Hermetic: HERMETIC_RESOLVER makes every mainnet name unresolvable, which is
// what forces the failure without contacting anything.
import { afterAll, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import type { ElectronApplication, Page } from 'playwright'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openNetworks (app: ElectronApplication): Promise<Page> {
  await waitFor(() => app.windows().length === 2)
  const chrome = findChrome(app)
  await waitForAddressBarStable(chrome)
  await chrome.click('#networks-btn')
  let panel: Page | undefined
  await waitFor(() => { panel = app.windows().find((w) => w.url().endsWith('/renderer/networks/index.html')); return panel !== undefined })
  if (panel === undefined) throw new Error('the Available networks popup did not open')
  return panel
}

/** The light client's card as the popup draws it: the status word, the sentence under it, and its switch. */
async function lightClient (panel: Page): Promise<{ state: string, summary: string, on: boolean, disabled: boolean }> {
  return await evaluateRetrying(panel, () => {
    const card = document.querySelector('.card[data-id="light-client"]')
    const control = card?.querySelector<HTMLButtonElement>('.switch')
    return {
      state: card?.querySelector('.card-status')?.textContent ?? '',
      summary: card?.querySelector('.card-note')?.textContent ?? '',
      on: control?.getAttribute('aria-checked') === 'true',
      disabled: control?.disabled ?? false
    }
  })
}

/** Types a .eth name into the address bar without pressing Enter, which is what starts the verifier host ahead of the request. */
async function typeEthAddress (app: ElectronApplication): Promise<void> {
  const chrome = findChrome(app)
  await chrome.click('#address')
  await chrome.fill('#address', 'status-check.eth')
}

async function verifierPid (app: ElectronApplication): Promise<number | undefined> {
  return await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'Orivon verifier')?.pid)
}

it('shows the light client off, with its switch fixed, when the run switches it off, while the verifier host still runs', async () => {
  await runPhase('light-client-off', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
    try {
      await waitFor(() => app.windows().length === 2)
      await waitForAddressBarStable(findChrome(app))
      const idleBefore = await verifierPid(app) === undefined
      check('no verifier host runs before a .eth address is opened', idleBefore)
      await typeEthAddress(app)
      const panel = await openNetworks(app)
      const off = await waitFor(async () => (await lightClient(panel)).state === 'Off', 15_000)
      const shown = await lightClient(panel)
      check(`switched off for the test run, the card says Off with its switch off and out of reach (${JSON.stringify(shown)})`, off && !shown.on && shown.disabled && /started with the light client switched off/.test(shown.summary))
      const pidReady = await waitFor(async () => await verifierPid(app) !== undefined, 15_000)
      check(`the verifier host runs as a utility process all the same (pid ${String(await verifierPid(app))})`, pidReady)
      expect([off, idleBefore, pidReady]).toEqual([true, true, true])
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

it('says the verifier is not running when its process dies, and recovers once the shell restarts it', async () => {
  await runPhase('light-client-down', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_ETH_LIGHT_CLIENT: 'on' }, seedProfile: seedFreshCheckpoint })
    try {
      await waitFor(() => app.windows().length === 2)
      await waitForAddressBarStable(findChrome(app))
      await typeEthAddress(app)
      const panel = await openNetworks(app)
      const pidReady = await waitFor(async () => await verifierPid(app) !== undefined, 15_000)
      const pid = await verifierPid(app)
      check(`the verifier host is running as a utility process (pid ${String(pid)})`, pidReady && pid !== undefined)
      if (pid === undefined) throw new Error('no verifier host process found')
      process.kill(pid, 'SIGKILL')
      const down = await waitFor(async () => (await lightClient(panel)).state === 'Not running' && /The verifier is not running/.test((await lightClient(panel)).summary), 10_000)
      check(`killing it shows Not running, pushed while the popup is open (${JSON.stringify(await lightClient(panel))})`, down)
      const back = await waitFor(async () => await verifierPid(app) !== undefined && !/The verifier is not running/.test((await lightClient(panel)).summary), 15_000)
      check('the shell restarts it, and the card recovers', back)
      expect([down, back]).toEqual([true, true])
    } finally {
      await closeElectronApp(app, APP_CLOSE_RACE_MS)
    }
  })
}, 120_000)

it('shows the light client failed, and why, when no beacon API can be reached', async () => {
  await runPhase('light-client-failed', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_ETH_LIGHT_CLIENT: 'on' }, seedProfile: seedFreshCheckpoint })
    try {
      const panel = await openNetworks(app)
      const waiting = await waitFor(async () => (await lightClient(panel)).state === 'Asleep', 15_000)
      const waitingShown = await lightClient(panel)
      check(`before any .eth address, the card says Asleep, that it starts when a page needs it, and its switch is on (${JSON.stringify(waitingShown)})`, waiting && /^Asleep: it starts when a page needs it/.test(waitingShown.summary) && waitingShown.on && await verifierPid(app) === undefined)
      await typeEthAddress(app)
      const opened = await openNetworks(app)
      const failed = await waitFor(async () => (await lightClient(opened)).state === 'Not running' && /Failed: /.test((await lightClient(opened)).summary), 45_000)
      const shown = await lightClient(opened)
      check(`the card says Not running with a reason and a retry (${JSON.stringify(shown)})`, failed && /Failed: .+\. Trying again/.test(shown.summary))
      const red = await waitFor(async () => (await findChrome(app).locator('#networks-btn .networks-dot').getAttribute('data-dot')) === 'red', 10_000)
      check('and the dot on the toolbar button turns red: a node the person switched on failed', red)
      expect([waiting, failed, red]).toEqual([true, true, true])
    } finally {
      await closeElectronApp(app, APP_CLOSE_RACE_MS)
    }
  })
}, 120_000)
