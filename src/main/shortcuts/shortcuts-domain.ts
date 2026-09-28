// What the Settings page may ask of the shortcuts: list them, start
// recording a new binding for one, clear or reset one, trade two. The keys
// themselves are read in main (./dispatcher.ts) and answered to the page as
// an event, so the page never has to interpret a keystroke.
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { ShortcutService } from './shortcut-service.js'

interface ShortcutsRequest {
  readonly type?: unknown
  readonly id?: unknown
  readonly other?: unknown
  readonly binding?: unknown
}

export function shortcutsDomain (service: ShortcutService): InternalDomain {
  return {
    pages: ['settings'],
    handle: (command, caller) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as ShortcutsRequest
      const id = typeof request.id === 'string' ? request.id : ''
      switch (request.type) {
        case 'list':
          return { platform: service.platform, rows: service.rows() }
        case 'record':
          return service.beginRecording(caller.contents, id)
        case 'cancelRecording':
          if (service.isRecording(caller.contents)) service.cancelRecording()
          return undefined
        case 'clear':
          service.clear(id)
          return undefined
        case 'reset':
          service.reset(id)
          return undefined
        case 'resetAll':
          service.resetAll()
          return undefined
        case 'swap':
          return service.swap(id, typeof request.other === 'string' ? request.other : '', typeof request.binding === 'string' ? request.binding : '')
        default:
          return undefined
      }
    }
  }
}
