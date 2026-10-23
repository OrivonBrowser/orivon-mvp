// What the Settings page may ask of the settings store, as one internal-IPC
// domain. The page's requests are data from a document, so nothing here trusts
// their shape: the store checks the key and the value itself.
import type { InternalDomain } from '../pages/internal-ipc.js'
import { describeSettings } from './schema.js'
import type { SettingsStore } from './settings-store.js'

interface SettingsRequest {
  readonly type?: unknown
  readonly key?: unknown
  readonly value?: unknown
}

export interface SettingsDomainOptions {
  /** True (or a promise of it) to refuse a value the store would take, for a setting whose value needs more than the store knows; undefined for a setting it has no say in. */
  readonly refuses?: (key: string, value: unknown) => boolean | Promise<boolean> | undefined
}

export function settingsDomain (settings: SettingsStore, options: SettingsDomainOptions = {}): InternalDomain {
  return {
    // The extensions page reads and writes 'extensions.developerMode' here rather than through a domain of its own.
    pages: ['settings', 'extensions'],
    handle: (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as SettingsRequest
      const key = typeof request.key === 'string' ? request.key : ''
      switch (request.type) {
        case 'get':
          return { descriptions: describeSettings(), ...settings.snapshot(), atStart: settings.valuesAtStart(), held: settings.heldKeys() }
        case 'set': {
          const check = options.refuses?.(key, request.value)
          if (check === undefined) return settings.set(key, request.value)
          return Promise.resolve(check).then((refused) => refused ? { ok: false, reason: 'invalid-value' } : settings.set(key, request.value))
        }
        case 'reset':
          return settings.reset(key)
        case 'resetAll':
          settings.resetAll()
          return { ok: true }
        default:
          return undefined
      }
    }
  }
}
