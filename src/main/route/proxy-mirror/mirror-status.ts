// What the mirror of the system's proxy settings is doing, as a handful of fixed words: the one place `orivon://report` and the
// log read it from. No address, URL or exception is ever part of it. Pure.

import type { SettingsSourceName, SystemSettings } from './settings-source.js'

/** `copied`: sessions are set to the mirrored config. Any other reason: they follow the system's own. `unfetched`: the system names a script that could not be fetched, or is not at an `http:` or `https:` address. */
export type MirrorReason =
  | 'copied'
  | 'starting'
  | 'held'
  | 'no-reader'
  | 'no-proxy'
  | 'unfetched'
  | 'detect'
  | 'unsupported'
  | 'unreadable'
  | 'disagrees'

export interface MirrorStatus {
  /** Where the settings are kept; `none` before the mirror has started. */
  readonly source: SettingsSourceName | 'none'
  /** What the last read came to; `unknown` before there was one. */
  readonly mode: SystemSettings['kind'] | 'unknown'
  readonly state: 'mirrored' | 'system'
  readonly reason: MirrorReason
}

const NOT_STARTED: MirrorStatus = { source: 'none', mode: 'unknown', state: 'system', reason: 'starting' }

let current: (() => MirrorStatus) | undefined

/** Called once at start by whoever runs the mirror. */
export function setMirrorStatusSource (next: (() => MirrorStatus) | undefined): void {
  current = next
}

export function mirrorStatus (): MirrorStatus {
  return current?.() ?? NOT_STARTED
}
