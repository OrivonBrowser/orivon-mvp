// Global Privacy Control as the engine sends it. Both states are Chromium features read when the process starts,
// so the saved setting decides here, ahead of the first window. Pure but for the command line it is handed.

/** Makes the network layer send `Sec-GPC: 1` on every request of every session, and every page, frame and worker
 * report `navigator.globalPrivacyControl === true`. */
export const SIGNAL_ON_FEATURE = 'GlobalPrivacyControlForce'

/** Exposes `navigator.globalPrivacyControl` in every page, frame and worker, reading `false` (the signal is
 * supported and not sent) where the browser would otherwise leave it undefined. */
export const SIGNAL_OFF_BLINK_FEATURE = 'GlobalPrivacyControl'

/** The part of Electron's command line this needs. */
export interface FeatureSwitches {
  getSwitchValue: (name: string) => string
  appendSwitch: (name: string, value: string) => void
}

/** `listed` with `feature` in it once; the others it already named stay. */
export function withFeature (listed: string, feature: string): string {
  const names = listed.split(',').filter((name) => name !== '')
  return (names.includes(feature) ? names : [...names, feature]).join(',')
}

/** `appendSwitch` replaces a switch's value, so what another part already listed is read first and kept. */
function listFeature (commandLine: FeatureSwitches, switchName: string, feature: string): void {
  commandLine.appendSwitch(switchName, withFeature(commandLine.getSwitchValue(switchName), feature))
}

/** Decides this process's signal: on sends it everywhere, off reports `false` everywhere. */
export function applyGlobalPrivacyControl (commandLine: FeatureSwitches, on: boolean): void {
  if (on) listFeature(commandLine, 'enable-features', SIGNAL_ON_FEATURE)
  else listFeature(commandLine, 'enable-blink-features', SIGNAL_OFF_BLINK_FEATURE)
}
