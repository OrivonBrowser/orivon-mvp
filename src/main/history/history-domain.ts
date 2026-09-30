// What the History page may ask of the history: read a page of it, and forget
// one page, a range of time or all of it. The requests are data from a
// document, so every field is checked here.
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { HistoryService } from './history-service.js'

interface HistoryRequest {
  readonly type?: unknown
  readonly search?: unknown
  readonly after?: unknown
  readonly limit?: unknown
  readonly id?: unknown
  readonly from?: unknown
  readonly to?: unknown
}

const MAX_SEARCH_LENGTH = 200

function cursorFrom (value: unknown): { lastVisit: number, id: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { lastVisit, id } = value as { lastVisit?: unknown, id?: unknown }
  return Number.isFinite(lastVisit) && Number.isInteger(id) ? { lastVisit: lastVisit as number, id: id as number } : undefined
}

export function historyDomain (history: HistoryService): InternalDomain {
  return {
    pages: ['history'],
    handle: (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as HistoryRequest
      switch (request.type) {
        case 'list': {
          const after = cursorFrom(request.after)
          const search = typeof request.search === 'string' ? request.search.slice(0, MAX_SEARCH_LENGTH) : undefined
          // Bounds are `history.list`'s own (the store clamps again, never
          // trusting this layer's arithmetic alone) -- this only keeps a
          // non-number, or a page reloading itself back to a deeper page
          // than it ever asked for, from reaching it at all.
          const limit = Number.isFinite(request.limit) ? Math.trunc(request.limit as number) : undefined
          return {
            entries: history.list({ ...(search === undefined ? {} : { search }), ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }) }),
            status: history.status()
          }
        }
        case 'remove':
          if (Number.isInteger(request.id)) history.remove(request.id as number)
          return { ok: true }
        case 'removeRange':
          if (Number.isFinite(request.from) && Number.isFinite(request.to) && (request.from as number) <= (request.to as number)) history.removeRange(request.from as number, request.to as number)
          return { ok: true }
        case 'clear':
          history.clear()
          return { ok: true }
        default:
          return undefined
      }
    }
  }
}
