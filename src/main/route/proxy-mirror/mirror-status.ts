// What the mirror of the system's proxy settings is doing, as a handful of fixed words: the one place `orivon://report` and the
// log read it from. No address, URL or exception is ever part of it. Pure.

import type { SettingsSourceName, SystemSettings } from './settings-source.js'

/** `copied`: sessions are set to the mirrored config. Any other reason: they follow the system's own. `starting`: no read yet, or a read has found settings the pass is still checking. `unfetched`: the system names a script that could not be fetched, or is not at an `http:` or `https:` address. */
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

/**
 * What Chromium answered, from a session on the system's own config, when asked which proxy carries two ordinary addresses, where the
 * settings say to look for a script. `direct`: both DIRECT, in a sample taken after the settings were last read and not long ago.
 * `not-direct`: a proxy, or no answer. `unsure`: no sample since the last read, or the last is too old.
 */
export type MirrorProbe = 'direct' | 'not-direct' | 'unsure'

export interface MirrorStatus {
  /** Where the settings are kept; `none` before the mirror has started. */
  readonly source: SettingsSourceName | 'none'
  /** What the last read came to; `unknown` before there was one. */
  readonly mode: SystemSettings['kind'] | 'unknown'
  readonly state: 'mirrored' | 'system'
  readonly reason: MirrorReason
  /** Only where `mode` is `detect`: the one fact that tells a search for a script that finds none from one that may find a script. */
  readonly probe?: MirrorProbe
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
