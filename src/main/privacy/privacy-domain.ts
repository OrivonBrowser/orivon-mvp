// What the Settings page may ask about privacy and data: how much is kept, and
// clearing it. Clearing goes through ./clear-data.ts, which the request must
// pass the shape check of before anything is forgotten.
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { HistoryService } from '../history/history-service.js'
import type { ZoomStore } from '../zoom/zoom-store.js'
import { clearBrowsingData, parseClearRequest } from './clear-data.js'
import type { ClearDeps } from './clear-data.js'

export function privacyDomain (history: HistoryService, zoomStore: Pick<ZoomStore, 'size'>, deps: ClearDeps): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, request?: unknown }
      switch (request.type) {
        case 'status':
          return { history: history.status(), zoomSites: zoomStore.size }
        case 'clear': {
          const parsed = parseClearRequest(request.request)
          return parsed === null ? undefined : await clearBrowsingData(parsed, deps)
        }
        default:
          return undefined
      }
    }
  }
}
