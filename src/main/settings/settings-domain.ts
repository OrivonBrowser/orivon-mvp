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

export function settingsDomain (settings: SettingsStore): InternalDomain {
  return {
    // The extensions page reads and writes 'extensions.developerMode' here rather than through a domain of its own.
    pages: ['settings', 'extensions'],
    handle: (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as SettingsRequest
      const key = typeof request.key === 'string' ? request.key : ''
      switch (request.type) {
        case 'get':
          return { descriptions: describeSettings(), ...settings.snapshot(), atStart: settings.valuesAtStart() }
        case 'set':
          return settings.set(key, request.value)
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
