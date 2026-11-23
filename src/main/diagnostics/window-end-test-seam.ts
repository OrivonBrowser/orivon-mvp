// Test builds only: lets an end-to-end test tell the main process that the window system ended its window, as the
// shell's `closed` handler does when `close` never ran, so a spec need not lose a real display connection. Gated on
// the same compiled-in flag as ../dev/dev-grant.ts, so an ordinary build carries none of it
// (scripts/check-dev-grant-absent.mjs looks for __orivonDevWindowSystemEnd and the variable's name in the output).

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  var __orivonDevWindowSystemEnd: (() => void) | undefined
}

/** Publishes the call a test makes from the main process. Nothing in an ordinary build. */
export function exposeWindowSystemEnd (end: () => void): void {
  if (SEAM_ENABLED) globalThis.__orivonDevWindowSystemEnd = end
}
