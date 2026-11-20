// Test builds only: when web pages may first load, for an end-to-end test that must know the gate has opened before it
// opens an address, and a delay that holds it shut so a test can look at the browser in the gap. Gated on the same
// compiled-in flag as ../dev/dev-grant.ts, so an ordinary build carries none of it
// (scripts/check-dev-grant-absent.mjs looks for __orivonDevStartup and the variable's name in the output).

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

export interface StartupSeam {
  /** Settles once web pages may load; a test awaits it from the main process. */
  webReady: Promise<void>
}

declare global {
  var __orivonDevStartup: StartupSeam | undefined
}

/** Publishes the promise a test awaits. Nothing in an ordinary build. */
export function exposeWebReady (webReady: Promise<void>): void {
  if (SEAM_ENABLED) globalThis.__orivonDevStartup = { webReady }
}

/** How long a test build holds the gate shut after the start-up work has ended; zero in an ordinary build. */
export function webReadyDelayMs (env: Readonly<Record<string, string | undefined>> = process.env): number {
  if (!SEAM_ENABLED) return 0
  const delay = Number(env['ORIVON_TEST_WEB_READY_DELAY_MS'])
  return Number.isFinite(delay) && delay > 0 ? delay : 0
}
