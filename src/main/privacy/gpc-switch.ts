// Global Privacy Control as the engine sends it: the signal is one Chromium feature, read when the process
// starts, so it is decided here from the saved setting, ahead of the first window. Pure but for the command line
// it is handed.

/** The Chromium feature that makes the network layer send `Sec-GPC: 1` on every request of every session, and
 * every page, frame and worker report `navigator.globalPrivacyControl === true`. */
export const GPC_FEATURE = 'GlobalPrivacyControlForce'

/** The part of Electron's command line this needs. */
export interface FeatureSwitches {
  getSwitchValue: (name: string) => string
  appendSwitch: (name: string, value: string) => void
}

/** `enabled` with `feature` in it once; the others it already named stay. */
export function withFeature (enabled: string, feature: string): string {
  const names = enabled.split(',').filter((name) => name !== '')
  return (names.includes(feature) ? names : [...names, feature]).join(',')
}

/** Turns the signal on for this process, or leaves it off. `appendSwitch` replaces a switch's value, so what another
 * part already asked to enable is read first and kept. */
export function applyGlobalPrivacyControl (commandLine: FeatureSwitches, on: boolean): void {
  if (!on) return
  commandLine.appendSwitch('enable-features', withFeature(commandLine.getSwitchValue('enable-features'), GPC_FEATURE))
}
