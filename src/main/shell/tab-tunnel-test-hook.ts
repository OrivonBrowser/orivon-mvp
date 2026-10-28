// Test-only reach into the tab tunnel choice for an e2e test, which cannot import a module of the running main process and
// has no screen to set the choice on yet: the same gate and reasoning as ./view-background-test-hook.ts.
import type { TabTunnelChoice } from '../route/tab-tunnel.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  var __orivonDevTabTunnel: {
    /** Gives the tab `tabId` (in any window) the choice, or takes it away with null; false when no window has the tab. */
    readonly set: (tabId: string, choice: TabTunnelChoice | null) => boolean
    /** The choice of the tab, or undefined. */
    readonly choiceOf: (tabId: string) => TabTunnelChoice | undefined
  } | undefined
}

/** Publishes the seam; a build that is not a test build publishes nothing. */
export function exposeTabTunnelForTests (seam: NonNullable<typeof globalThis.__orivonDevTabTunnel>): void {
  if (SEAM_ENABLED) globalThis.__orivonDevTabTunnel = seam
}
