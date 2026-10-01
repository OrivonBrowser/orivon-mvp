// What the panel's page may ask main for. The page is untrusted: every field is checked here, and an ask that
// is not exactly one of these is dropped. Ids are only ever names of things the views list, never addresses.

export type OpenHow = 'current' | 'background' | 'window'

export type PanelRequest =
  | { type: 'rows', view: string, query: string, open: string[] }
  | { type: 'open', view: string, id: string, how: OpenHow }
  | { type: 'remove', view: string, id: string }
  | { type: 'menu', view: string, id: string }
  | { type: 'view', view: string }
  | { type: 'page', view: string }
  | { type: 'resize', width: number }
  | { type: 'focus-page' }
  | { type: 'close' }

const MAX_VIEW = 40
const MAX_ID = 200
const MAX_QUERY = 200
const MAX_OPEN = 500

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

export function asRequest (command: unknown): PanelRequest | undefined {
  if (!isRecord(command)) return undefined
  const { type, view, id, how, query, open, width } = command
  switch (type) {
    case 'rows':
      if (!text(view, MAX_VIEW) || typeof query !== 'string' || query.length > MAX_QUERY) return undefined
      if (!Array.isArray(open) || open.length > MAX_OPEN || !open.every((entry): entry is string => text(entry, MAX_ID))) return undefined
      return { type, view, query, open }
    case 'open':
      if (!text(view, MAX_VIEW) || !text(id, MAX_ID) || (how !== 'current' && how !== 'background' && how !== 'window')) return undefined
      return { type, view, id, how }
    case 'remove': case 'menu':
      return text(view, MAX_VIEW) && text(id, MAX_ID) ? { type, view, id } : undefined
    case 'view': case 'page':
      return text(view, MAX_VIEW) ? { type, view } : undefined
    case 'resize':
      return typeof width === 'number' && Number.isFinite(width) ? { type, width } : undefined
    case 'focus-page': case 'close':
      return { type }
    default:
      return undefined
  }
}
