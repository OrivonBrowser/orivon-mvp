// What a test says about the system's settings before it drives a guard: the guard refuses a name without asking when it does not know them.

import { setMirrorStatusSource } from '../proxy-mirror/mirror-status.js'
import type { MirrorStatus } from '../proxy-mirror/mirror-status.js'

/** A computer with no proxy: no code of the system's can see a name. */
export const NO_PROXY_STATUS: MirrorStatus = { source: 'gnome', mode: 'none', state: 'system', reason: 'no-proxy' }

/** The mirror found what `facts` says about the system's settings. */
export function systemSettingsAre (facts: Partial<MirrorStatus> = {}): void {
  const status: MirrorStatus = { ...NO_PROXY_STATUS, ...facts }
  setMirrorStatusSource(() => status)
}

/** Back to a run whose mirror never started. */
export function forgetSystemSettings (): void {
  setMirrorStatusSource(undefined)
}
