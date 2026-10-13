// A page's `<link rel="dns-prefetch">` makes the engine resolve that name on this computer, even when every request of
// the page goes through a proxy that resolves it far away (measured: the name reached this computer's resolver). The
// setting is read when the process starts, so it is set ahead of `ready`, for every session and every page.

import type { FeatureSwitches } from './gpc-switch.js'

export const DNS_PREFETCH_SETTING = 'dnsPrefetchingEnabled'

/** `listed` (`key=value,key=value`) with `key` set to `value` once; the other settings stay. */
export function withBlinkSetting (listed: string, key: string, value: string): string {
  const kept = listed.split(',').filter((entry) => entry !== '' && entry.split('=')[0] !== key)
  return [...kept, `${key}=${value}`].join(',')
}

/** `appendSwitch` replaces a switch's value, so what another part already set is read first and kept. */
export function disableDnsPrefetching (commandLine: FeatureSwitches): void {
  commandLine.appendSwitch('blink-settings', withBlinkSetting(commandLine.getSwitchValue('blink-settings'), DNS_PREFETCH_SETTING, 'false'))
}
