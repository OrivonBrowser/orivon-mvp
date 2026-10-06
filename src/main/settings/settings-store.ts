// The person's settings for this profile: what they chose, with a default for
// everything they did not. Only choices that differ from the default are
// written, so a default that improves reaches everyone who never touched it.
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { SETTINGS, isSettingKey, validateSetting } from './schema.js'
import { SETTINGS_FILE_VERSION, settingsFromFile } from './settings-file.js'
import type { SettingKey, SettingValue, SettingsValues } from './schema.js'

export type SetResult = { readonly ok: true } | { readonly ok: false, readonly reason: 'unknown-key' | 'invalid-value' }

export interface SettingChange {
  readonly key: SettingKey
  readonly value: SettingValue
}

/** Every setting's effective value, and which of them differ from the default. */
export interface SettingsSnapshot {
  readonly values: Readonly<Record<SettingKey, SettingValue>>
  readonly changed: readonly SettingKey[]
}

export class SettingsStore {
  private readonly overrides = new Map<SettingKey, SettingValue>()
  private readonly listeners = new Set<(change: SettingChange) => void>()
  private loading: Promise<void> | null = null
  private atStart: Readonly<Record<SettingKey, SettingValue>> | null = null
  private readonly writer = new DebouncedWriter(async () => { this.writeNow() })

  constructor (private readonly filePath: string) {}

  /** Reads the file once, however many callers ask. A missing, unreadable or
   * corrupt file, and any entry the schema would refuse, leaves the default:
   * a browser that will not start over its own settings file is worse than
   * one that forgot a choice. */
  load (): Promise<void> {
    this.loading ??= this.readFromDisk().then(() => { this.atStart = this.snapshot().values })
    return this.loading
  }

  private async readFromDisk (): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] settings file unreadable, using defaults:', error)
      return
    }
    const { overrides, dropped } = settingsFromFile(parsed)
    for (const [key, value] of overrides) this.overrides.set(key, value)
    if (dropped > 0) console.warn(`[orivon] ${String(dropped)} setting(s) in the settings file were not valid and were ignored`)
  }

  get<K extends SettingKey>(key: K): SettingsValues[K] {
    // Every value that reaches the map passed validateSetting for this key.
    return (this.overrides.get(key) ?? SETTINGS[key].default) as SettingsValues[K]
  }

  isDefault (key: SettingKey): boolean {
    return !this.overrides.has(key)
  }

  snapshot (): SettingsSnapshot {
    const values = {} as Record<SettingKey, SettingValue>
    for (const key of Object.keys(SETTINGS) as SettingKey[]) values[key] = this.get(key)
    return { values, changed: [...this.overrides.keys()] }
  }

  /** Every value as the file gave it at start, for a setting that is read once, when the process starts. */
  valuesAtStart (): Readonly<Record<SettingKey, SettingValue>> {
    return this.atStart ?? this.snapshot().values
  }

  /** `key` and `value` come from the Settings page, so both are checked. */
  set (key: string, value: unknown): SetResult {
    if (!isSettingKey(key)) return { ok: false, reason: 'unknown-key' }
    const accepted = validateSetting(SETTINGS[key], value)
    if (accepted === undefined) return { ok: false, reason: 'invalid-value' }
    this.apply(key, accepted)
    return { ok: true }
  }

  reset (key: string): SetResult {
    if (!isSettingKey(key)) return { ok: false, reason: 'unknown-key' }
    this.apply(key, SETTINGS[key].default)
    return { ok: true }
  }

  resetAll (): void {
    for (const key of [...this.overrides.keys()]) this.apply(key, SETTINGS[key].default)
  }

  /** Returns the removal: a window that closes must stop listening. */
  onChange (listener: (change: SettingChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Resolves once the file reflects every change made so far. */
  async flush (): Promise<void> {
    await this.writer.flush()
  }

  private apply (key: SettingKey, value: SettingValue): void {
    if (this.get(key) === value) return
    if (value === SETTINGS[key].default) this.overrides.delete(key)
    else this.overrides.set(key, value)
    this.writer.schedule()
    for (const listener of this.listeners) listener({ key, value })
  }

  private writeNow (): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify({ version: SETTINGS_FILE_VERSION, values: Object.fromEntries(this.overrides) }, null, 2))
    } catch (error) {
      console.error('[orivon] failed to persist settings:', error)
      throw error
    }
  }
}
