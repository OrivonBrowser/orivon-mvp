// Test-only reach into the panel for an e2e test, which cannot import a module of the running main process:
// the same gate and reasoning as ../shell/view-background-test-hook.ts.
import { onGuestChosen } from './side-panel-guests.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  var __orivonDevSidePanel: { host: (windowIndex: number) => unknown, setGuestEntries: (entries: unknown) => void, setSetting: (key: string, value: unknown) => void, chosen: string[] } | undefined
}

/** Exposes `host(i)` (the i-th window's panel), `setGuestEntries`, `setSetting` and the ids `onGuestChosen` heard.
 * The listener that collects those ids exists only where the seam does. */
export function exposeSidePanelForTests (seam: Omit<NonNullable<typeof globalThis.__orivonDevSidePanel>, 'chosen'>): void {
  if (!SEAM_ENABLED) return
  const chosen: string[] = []
  onGuestChosen((_window, id) => { chosen.push(id) })
  globalThis.__orivonDevSidePanel = { ...seam, chosen }
}
