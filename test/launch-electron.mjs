// Shared launcher for every Electron-driving test/smoke script in this repo.
//
// WHY THIS EXISTS -- read before "simplifying" it away.
//
// This machine has ELECTRON_RUN_AS_NODE=1 set in the ambient environment. That
// variable makes the Electron binary behave as plain Node: no windows, no
// `require('electron')`, and critically NO MessagePortMain. Under that
// variable Electron-driving code does not fail loudly -- it fails in ways
// that look like unrelated bugs, and the whole point of a smoke/e2e run is to
// produce a trustworthy result.
//
// It cost roughly an hour during the week-0 spike (2026-08-25), and the
// misleading symptom was a module-format error that had nothing to do with
// module formats. So the variable is stripped here and the launch asserts it
// really is Electron.
//
// Ported verbatim from spike/launch.mjs (build step 1, 2026-08-26) -- this is
// the load-bearing bit that must survive spike/ being deleted. See
// .claude/skills/orivon-electron/SKILL.md for the full incident writeup.
import { _electron as electron } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Environment variables that silently change what the binary IS. */
const POISON = ['ELECTRON_RUN_AS_NODE']

/**
 * Ceiling on any single Playwright ACTION (click, fill, press) started
 * through an app launched here.
 *
 * WHY IT IS SET AT ALL. Every action in this repo targets a local Electron
 * window and lands in milliseconds; nothing legitimately waits seconds. But an
 * action whose selector cannot match does not fail — it blocks. A smoke run
 * that blocks produces no JSON result and no failure list, which is precisely
 * the outcome `scripts/smoke.mjs` exists to rule out (its header, and
 * `scripts/README.md`: read the result, not the exit code). Ten seconds is far
 * above any real action here and far below "a human gave up and hit Ctrl-C".
 *
 * DOES NOT COVER `page.evaluate()` -- found 2026-08-28. This context option
 * only applies to Playwright's own action methods; `evaluate()` has no
 * timeout in this Playwright version regardless of this setting (confirmed
 * against the installed source: it passes `kNoTimeout` internally). Every
 * call site in this repo goes through `test/smoke-helpers.mjs`'s
 * `evaluateRetrying()`, which races the evaluate against its own deadline
 * explicitly for exactly this reason -- do not assume this constant covers
 * it.
 */
export const DEFAULT_ACTION_TIMEOUT_MS = 10_000

/**
 * @param {object} [options]
 * @param {string} [options.appPath] Directory of the app to run. Defaults to
 *   the repo root (the real app); tests may pass a fixture directory.
 * @param {string[]} [options.args] Extra argv for the Electron process.
 * @param {number} [options.defaultTimeoutMs] Ceiling on any single Playwright
 *   action. See DEFAULT_ACTION_TIMEOUT_MS — raise it deliberately or not at all.
 * @returns {Promise<import('playwright').ElectronApplication>} Launched
 *   against a fresh, unique --user-data-dir -- never this machine's real
 *   `orivon` profile. See the userDataDir comment below.
 */
export async function launchElectron ({
  appPath = '.',
  args = [],
  defaultTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS
} = {}) {
  const env = { ...process.env }
  const stripped = []
  for (const key of POISON) {
    if (env[key] !== undefined) {
      delete env[key]
      stripped.push(key)
    }
  }
  if (stripped.length > 0) {
    console.log(`[launch] stripped from env: ${stripped.join(', ')}`)
  }

  // BUG (found 2026-09-01, real regression): with no --user-data-dir, Electron
  // defaults to this machine's actual `orivon` profile directory
  // (app.getPath('userData'), ~/.config/orivon on Linux) -- the SAME one a
  // real `npm run dev` writes to. HERMETIC_RESOLVER (scripts/smoke.mjs)
  // blackholes the network, but nothing blackholed disk state: a leftover
  // bookmarks.json from an earlier manual run silently added a second tile
  // to the dashboard's bookmarks grid, which `page.click('#bookmarks-grid
  // .tile')` (a plain CSS selector, not a strict Locator) clicked instead of
  // the fixture the test just starred -- confirmed by reading that file's
  // actual contents on this machine. A fresh, unique directory per launch is
  // what "hermetic by construction" (this file's own header, and
  // smoke.mjs's) already promised for the network; it never covered disk.
  const userDataDir = await mkdtemp(join(tmpdir(), 'orivon-test-'))
  const app = await electron.launch({
    args: [appPath, `--user-data-dir=${userDataDir}`, ...args],
    env
  })

  // Applies to every page this app produces, including tab views created
  // later. Without it a click on a selector that cannot match blocks instead
  // of failing — see DEFAULT_ACTION_TIMEOUT_MS.
  app.context().setDefaultTimeout(defaultTimeoutMs)

  // Forward MAIN-process stdout/stderr. Without this, console output from the
  // main process is swallowed -- Playwright captures the child's streams and
  // does not relay them -- so a run can look silent when the main side is
  // talking.
  app.process().stdout?.on('data', (d) => process.stderr.write(`[main] ${d}`))
  app.process().stderr?.on('data', (d) => process.stderr.write(`[main] ${d}`))

  // Assert we got Electron, not Node wearing its binary. If this throws, no
  // result from this run may be trusted.
  const isReal = await app.evaluate(async ({ app: electronApp, MessageChannelMain }) => {
    return typeof electronApp?.getVersion === 'function' &&
           typeof MessageChannelMain === 'function'
  })
  if (isReal !== true) {
    await app.close()
    throw new Error(
      'Launched binary is not a real Electron main process ' +
      '(no app.getVersion or no MessageChannelMain). Refusing to trust this run.'
    )
  }

  return app
}
