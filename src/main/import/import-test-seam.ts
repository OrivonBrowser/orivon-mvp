// Test builds only: lets an end-to-end test point the detector at a fake home directory through
// ORIVON_TEST_IMPORT_HOME, so it never reads the real browsers of whoever runs it. The code that reads the
// variable exists only where the developer flag is compiled in (the same flag the developer grant uses), so an
// ordinary build carries none of it and the variable does nothing there.
import type { ImportEnv } from './browser-roots.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

export interface ImportLocation {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly env: ImportEnv
}

/** This machine's own place, or, in a test build given the variable, a directory standing in for the home: no
 * environment variable of the real machine then reaches the detector, so nothing outside that directory is read. */
export function importLocation (real: ImportLocation, env: NodeJS.ProcessEnv = process.env): ImportLocation {
  if (!SEAM_ENABLED) return real
  const fake = env['ORIVON_TEST_IMPORT_HOME']
  if (fake === undefined || fake === '') return real
  return { platform: real.platform, home: fake, env: {} }
}
