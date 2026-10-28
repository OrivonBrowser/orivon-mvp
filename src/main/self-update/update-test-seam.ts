// Test builds only: ORIVON_TEST_UPDATE_RELEASE=<tag> stands a release of that tag in for the GitHub answer, and
// `__orivonDevUpdateCheckNow` runs one scheduled look even though every test launch forces the checks off
// (`ORIVON_UPDATE_CHECK=off`), so an e2e can prove what the person is shown without reaching GitHub. Gated on the
// compiled-in flag the developer grant uses (../dev/dev-grant.ts), so an ordinary build carries none of it:
// scripts/check-dev-grant-absent.mjs looks for the names below in the output.
import { releaseUrl } from './release-url.js'
import type { FetchLatestRelease } from './update-check.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  // `var`: TypeScript requires it for a `declare global` augmentation.
  var __orivonDevUpdateCheckNow: (() => Promise<void>) | undefined
}

/** Undefined outside a test build, where SEAM_ENABLED is a literal `false` and this whole branch is dead code. */
export function testUpdateFetch (env: NodeJS.ProcessEnv = process.env): FetchLatestRelease | undefined {
  if (!SEAM_ENABLED) return undefined
  const tag = env['ORIVON_TEST_UPDATE_RELEASE']
  if (tag === undefined || tag === '') return undefined
  return async () => ({ version: tag, url: releaseUrl(tag) })
}

/** Lets a test run the scheduled look now, instead of waiting for the schedule that a test launch switches off. */
export function exposeUpdateCheckNow (run: () => Promise<void>): void {
  if (SEAM_ENABLED) globalThis.__orivonDevUpdateCheckNow = run
}
