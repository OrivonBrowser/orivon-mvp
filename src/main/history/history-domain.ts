// What the History page may ask of the history: read a page of it, forget
// pages, a range of time or all of it, and act on rows by id. The requests are
// data from a document, so every field is checked here.
import type { InternalDomain } from '../pages/internal-ipc.js'
import { handleHistoryAction } from './history-actions.js'
import type { HistoryActionDeps } from './history-actions.js'
import { MAX_IDS } from './history-ids.js'
import type { HistoryService } from './history-service.js'
import type { HistoryOrder } from './history-store.js'

interface HistoryRequest {
  readonly type?: unknown
  readonly search?: unknown
  readonly after?: unknown
  readonly limit?: unknown
  readonly id?: unknown
  readonly ids?: unknown
  readonly order?: unknown
  readonly offset?: unknown
  readonly disposition?: unknown
  readonly from?: unknown
  readonly to?: unknown
}

const MAX_SEARCH_LENGTH = 200
const ORDERS: readonly HistoryOrder[] = ['recent', 'visits', 'title']

function cursorFrom (value: unknown): { lastVisit: number, id: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { lastVisit, id } = value as { lastVisit?: unknown, id?: unknown }
  return Number.isFinite(lastVisit) && Number.isInteger(id) ? { lastVisit: lastVisit as number, id: id as number } : undefined
}

/** Without `actions` the domain answers only what needs no window: a page's own rows, never a tab. */
export function historyDomain (history: HistoryService, actions?: HistoryActionDeps): InternalDomain {
  return {
    pages: ['history'],
    handle: (command, caller) => {
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
          const query = { ...(search === undefined ? {} : { search }), ...(limit === undefined ? {} : { limit }) }
          const order = ORDERS.find((candidate) => candidate === request.order)
          // Most visited and by title have no cursor: the page pages through them by offset.
          if (order !== undefined && order !== 'recent') {
            const offset = Number.isFinite(request.offset) ? Math.trunc(request.offset as number) : undefined
            return { entries: history.listOrdered({ ...query, order, ...(offset === undefined ? {} : { offset }) }), status: history.status() }
          }
          return { entries: history.list({ ...query, ...(after === undefined ? {} : { after }) }), status: history.status() }
        }
        case 'remove':
          if (Number.isInteger(request.id)) history.remove(request.id as number)
          return { ok: true, status: history.status() }
        case 'removeMany':
          if (!Array.isArray(request.ids) || request.ids.length > MAX_IDS || !request.ids.every((id) => Number.isInteger(id))) return undefined
          if (request.ids.length > 0) history.removeMany(request.ids as number[])
          return { ok: true, status: history.status() }
        case 'removeRange':
          if (Number.isFinite(request.from) && Number.isFinite(request.to) && (request.from as number) <= (request.to as number)) history.removeRange(request.from as number, request.to as number)
          return { ok: true }
        case 'clear':
          history.clear()
          return { ok: true }
        default:
          return actions === undefined ? undefined : handleHistoryAction(request, caller, history, actions)
      }
    }
  }
}
