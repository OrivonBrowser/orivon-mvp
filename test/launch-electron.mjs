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

/** Environment variables that silently change what the binary IS. */
const POISON = ['ELECTRON_RUN_AS_NODE']

/**
 * @param {object} [options]
 * @param {string} [options.appPath] Directory of the app to run. Defaults to
 *   the repo root (the real app); tests may pass a fixture directory.
 * @param {string[]} [options.args] Extra argv for the Electron process.
 * @returns {Promise<import('playwright').ElectronApplication>}
 */
export async function launchElectron ({ appPath = '.', args = [] } = {}) {
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

  const app = await electron.launch({ args: [appPath, ...args], env })

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
