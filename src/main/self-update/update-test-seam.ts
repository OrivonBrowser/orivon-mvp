// Test builds only: ORIVON_TEST_UPDATE_SOURCE=http://127.0.0.1:<port> stands a local server in for GitHub,
// ORIVON_TEST_UPDATE_KEY trusts one more signing key, and ORIVON_TEST_UPDATE_INSTALL=record replaces the installers
// with one that records what it was handed and installs nothing. Gated on the compiled-in flag the developer grant
// uses (../dev/dev-grant.ts), so an ordinary build carries none of it: scripts/check-dev-grant-absent.mjs looks for
// the names below in the output.
declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

export interface RecordedInstall {
  readonly kind: string
  readonly file: string
  readonly sha256: string
}

declare global {
  // `var`: TypeScript requires it for a `declare global` augmentation.
  var __orivonDevUpdateInstalls: RecordedInstall[] | undefined
  var __orivonDevUpdateCheckNow: (() => Promise<void>) | undefined
}

export interface UpdateSeam {
  readonly source: string | undefined
  readonly key: string | undefined
  readonly record: boolean
}

/** Undefined outside a test build, where SEAM_ENABLED is a literal `false` and this whole branch is dead code. */
export function updateSeam (env: NodeJS.ProcessEnv = process.env): UpdateSeam | undefined {
  if (!SEAM_ENABLED) return undefined
  const source = env['ORIVON_TEST_UPDATE_SOURCE']
  const key = env['ORIVON_TEST_UPDATE_KEY']
  const record = env['ORIVON_TEST_UPDATE_INSTALL'] === 'record'
  if (source === undefined && key === undefined && !record) return undefined
  return { source: source === '' ? undefined : source, key: key === '' ? undefined : key, record }
}

/** True in a test build: the scheduled check then runs from source too, so an end-to-end run can reach it. */
export const isUpdateTestBuild = (): boolean => SEAM_ENABLED

export function recordInstall (entry: RecordedInstall): void {
  if (!SEAM_ENABLED) return
  ;(globalThis.__orivonDevUpdateInstalls ??= []).push(entry)
}

/** Lets a test run the daily look now, instead of waiting for its clock. */
export function exposeCheckNow (check: () => Promise<void>): void {
  if (SEAM_ENABLED) globalThis.__orivonDevUpdateCheckNow = check
}
