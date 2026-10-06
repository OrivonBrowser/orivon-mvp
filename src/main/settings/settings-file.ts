// Reading the settings file: what its text holds, validated against the schema, with no file access in the pure
// part. The store reads it with the rest of start-up; `readSettingBeforeReady` reads one value ahead of everything,
// for a setting that Chromium takes as a command-line switch before the first window.
import { readFileSync } from 'node:fs'
import { SETTINGS, isSettingKey, validateSetting } from './schema.js'
import type { SettingKey, SettingValue, SettingsValues } from './schema.js'

export const SETTINGS_FILE_VERSION = 1

export interface ParsedSettings {
  /** Every accepted entry that differs from its default: the only ones the store keeps. */
  readonly overrides: ReadonlyMap<SettingKey, SettingValue>
  /** Entries the schema refused. */
  readonly dropped: number
}

/** What a parsed settings file holds; nothing at all when it is not a settings file of this version. */
export function settingsFromFile (parsed: unknown): ParsedSettings {
  const overrides = new Map<SettingKey, SettingValue>()
  if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== SETTINGS_FILE_VERSION) return { overrides, dropped: 0 }
  const values = (parsed as { values?: unknown }).values
  if (typeof values !== 'object' || values === null) return { overrides, dropped: 0 }
  let dropped = 0
  for (const [key, value] of Object.entries(values)) {
    const accepted = isSettingKey(key) ? validateSetting(SETTINGS[key], value) : undefined
    if (accepted === undefined || !isSettingKey(key)) { dropped += 1; continue }
    if (accepted !== SETTINGS[key].default) overrides.set(key, accepted)
  }
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
