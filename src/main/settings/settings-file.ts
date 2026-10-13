// Reading the settings file: what its text holds, validated against the schema, with no file access in the pure
// part. The store reads it with the rest of start-up; `readSettingBeforeReady` reads one value ahead of everything,
// for a setting that Chromium takes as a command-line switch before the first window.
import { existsSync, readFileSync } from 'node:fs'
import { SETTINGS, isSettingKey, validateSetting } from './schema.js'
import type { SettingKey, SettingValue, SettingsValues } from './schema.js'

/** The version the store writes. Version 1 files are read too, and gain the choices their version never had (`fromVersion1`). */
export const SETTINGS_FILE_VERSION = 2

export interface ParsedSettings {
  /** Every accepted entry that differs from its default: the only ones the store keeps. */
  readonly overrides: ReadonlyMap<SettingKey, SettingValue>
  /** Entries the schema refused. */
  readonly dropped: number
}

/**
 * A file written before the route had a choice of where it leaves holds an address and no choice: that person set up
 * their own SOCKS5 server, so that stays their choice. Only the file's version says so, because a choice left at its
 * default is never written, so a version 2 file with an address and no choice is a person who chose Nym.
 */
function fromVersion1 (overrides: Map<SettingKey, SettingValue>): void {
  const address = overrides.get('network.route.proxy')
  if (typeof address === 'string' && address !== '' && !overrides.has('network.route.kind')) overrides.set('network.route.kind', 'socks5')
}

/** Whether `parsed` is the content of a settings file of a version this build reads. */
export function isSettingsFile (parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false
  const { version, values } = parsed as { version?: unknown, values?: unknown }
  return (version === SETTINGS_FILE_VERSION || version === 1) && typeof values === 'object' && values !== null
}

/** What a parsed settings file holds; nothing at all when it is not a settings file of a version this build reads. */
export function settingsFromFile (parsed: unknown): ParsedSettings {
  const overrides = new Map<SettingKey, SettingValue>()
  const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined
  if (typeof parsed !== 'object' || parsed === null || (version !== SETTINGS_FILE_VERSION && version !== 1)) return { overrides, dropped: 0 }
  const values = (parsed as { values?: unknown }).values
  if (typeof values !== 'object' || values === null) return { overrides, dropped: 0 }
  let dropped = 0
  for (const [key, value] of Object.entries(values)) {
    const accepted = isSettingKey(key) ? validateSetting(SETTINGS[key], value) : undefined
    if (accepted === undefined || !isSettingKey(key)) { dropped += 1; continue }
    if (accepted !== SETTINGS[key].default) overrides.set(key, accepted)
  }
  if (version === 1) fromVersion1(overrides)
  return { overrides, dropped }
}

/** The saved value of `key`, or its default when the file is missing, unreadable or does not hold it. Synchronous, and never throws. */
export function readSettingBeforeReady<K extends SettingKey> (filePath: string, key: K): SettingsValues[K] {
  let overrides: ParsedSettings['overrides']
  try {
    overrides = settingsFromFile(JSON.parse(readFileSync(filePath, 'utf8'))).overrides
  } catch {
    return SETTINGS[key].default as SettingsValues[K]
  }
  return (overrides.get(key) ?? SETTINGS[key].default) as SettingsValues[K]
}

/**
 * Whether the settings file is there but cannot be used: not readable, not JSON, or not a settings file of a version this
 * build reads. A file that is missing is no problem (the defaults apply). Synchronous, and never throws.
 */
export function settingsFileProblem (filePath: string): 'unreadable' | undefined {
  try {
    if (!existsSync(filePath)) return undefined
    return isSettingsFile(JSON.parse(readFileSync(filePath, 'utf8'))) ? undefined : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/** Whether the whole browser goes through the tunnel at start: the saved setting, or on when the file that holds it cannot be used, so that a damaged file never sends anything around the tunnel. */
export function everywhereBeforeReady (filePath: string): boolean {
  return settingsFileProblem(filePath) !== undefined || readSettingBeforeReady(filePath, 'network.tunnel.everywhere')
}
