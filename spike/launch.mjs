// Shared launcher for every spike gate.
//
// WHY THIS EXISTS -- read before "simplifying" it away.
//
// This machine has ELECTRON_RUN_AS_NODE=1 set in the ambient environment. That
// variable makes the Electron binary behave as plain Node: no windows, no
// `require('electron')`, and critically NO MessagePortMain. Gate 0 measures
// MessagePortMain; gates 1a and 1b run inside a renderer. Under that variable
// they do not fail loudly -- they fail in ways that look like architectural
// findings, and the whole point of the spike is to produce a trustworthy
// verdict about the architecture.
//
// It cost roughly an hour on 2026-08-25, and the misleading symptom was a
// module-format error that had nothing to do with module formats. So the
// variable is stripped here and the launch asserts it really is Electron.
import { _electron as electron } from 'playwright'

/** Environment variables that silently change what the binary IS. */
const POISON = ['ELECTRON_RUN_AS_NODE']

/**
 * @param {object} [options]
 * @param {string[]} [options.args] Extra argv for the Electron process.
 * @returns {Promise<import('playwright').ElectronApplication>}
 */
export async function launchElectron ({ args = [] } = {}) {
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

  const app = await electron.launch({ args: ['.', ...args], env })

  // Assert we got Electron, not Node wearing its binary. If this throws, no
  // gate result from this run may be trusted.
  const isReal = await app.evaluate(async ({ app: electronApp, MessageChannelMain }) => {
    return typeof electronApp?.getVersion === 'function' &&
           typeof MessageChannelMain === 'function'
  })
  if (isReal !== true) {
    await app.close()
    throw new Error(
      'Launched binary is not a real Electron main process ' +
      '(no app.getVersion or no MessageChannelMain). Refusing to record a gate result.'
    )
  }

  return app
}
