// Visual QA of the new tab's "Update Orivon" button, in the same way as e2e-qa-visual: each state is reached through the
// real UI, audited, compared with a machine-local baseline and written to qa-artifacts/latest/states/ for reading.
// The states: the button at the page's top left over the Orivon picture, and over no picture, in light and in dark.
//
// Run: npm run qa:visual      First run on a machine records baselines;
//      ORIVON_QA_UPDATE_BASELINES=1 re-records after an intended change.

import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { answerQuestion, noNativeDialogs, questionGone, stubNativeDialogs } from '../support/question-support.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { captureState, checkState, prepareWindow, SCHEMES, type Check, type StateSpec } from '../support/qa-visual.js'
import { ABSENCE_SETTLE_MS, waitFor } from '../support/smoke-helpers.mjs'

async function state (check: Check, app: ElectronApplication, name: string, spec: StateSpec): Promise<void> {
  await prepareWindow(app)
  checkState(check, await captureState(app, name, spec))
}

const dashboardOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().endsWith('/newtab/index.html'))

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

for (const scheme of SCHEMES) {
  it(`the new tab shows the Update Orivon button at its top left while a release is on offer, readable on the picture and on none (${scheme})`, async () => {
    const { app } = await launchShell({ scheme, env: { ORIVON_TEST_UPDATE_RELEASE: 'v99.0.0' } })
    try {
      await runPhase('visual state of the update button', async (check) => {
        expect(await waitFor(() => dashboardOf(app) !== undefined)).toBe(true)
        const dashboard = dashboardOf(app) as Page
        await dashboard.waitForSelector('html[data-settled="1"]')
        await stubNativeDialogs(app)
        await app.evaluate(async () => { await (globalThis as unknown as { __orivonDevUpdateCheckNow?: () => Promise<void> }).__orivonDevUpdateCheckNow?.() })
        await dashboard.waitForSelector('#update-pill:not([hidden])')
        // A window the system gives the keyboard (a macOS runner) is asked at once, one it does not (Windows, headless Linux) is not:
        // absence cannot be polled for, so settle once, and answer a question that came before the capture, which is about the button.
        if (await waitFor(async () => !(await questionGone(app)), ABSENCE_SETTLE_MS * 2)) {
          await answerQuestion(app, 'Not now')
          expect(await waitFor(async () => await questionGone(app))).toBe(true)
        }
        check('the button names the release and the running version in its tooltip', /^Orivon 99\.0\.0 is available\. You have \d+\.\d+\.\d+/.test(await dashboard.getAttribute('#update-pill', 'title') ?? ''))
        await state(check, app, `update-pill-${scheme}`, {
          expected: 'The new-tab dashboard as it is with no release on offer, no question panel over it, and in its top left corner, 16px in from the window edges, a small accent-filled (indigo) pill with an upward arrow in a circle and the white text "Update Orivon"; it is whole, vertically centred in its own height, clear of the Orivon mark and the search box, and the Report a bug pill is still at the bottom right.',
          action: 'Pointed the update check at a release newer than the running one, ran the check and, where a question about it opened, answered Not now.'
        })
        await dashboard.evaluate(() => { document.documentElement.dataset['background'] = 'none' })
        await state(check, app, `update-pill-no-picture-${scheme}`, {
          expected: 'The dashboard on its plain base colour (no picture), with the same indigo "Update Orivon" pill in its top left corner, whole and readable.',
          action: 'Switched the page to the no-picture background, as the Settings choice does.'
        })
        check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
      })
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)
}
