// What main sends the panel page and how the page reads it. The page trusts nothing it is handed beyond its
// shape: a field of the wrong type drops the whole message.
import type { PanelIcon, PanelRow } from '../../../main/side-panel/panel-types.js'
import type { Limits, Side } from './resize.js'

export interface ViewMeta {
  id: string
  title: string
  icon: PanelIcon
  searchLabel: string
  things: string
  page: string | null
  removable: boolean
  empty: string
}
export interface GuestMeta { id: string, title: string, icon?: string }

export interface Shown {
  views: ViewMeta[]
  guests: GuestMeta[]
  view: string
  guest: GuestMeta | null
  side: Side
  width: number
  limits: Limits
  isPrivate: boolean
  /** The folders the tree opens expanded the first time it is shown, and the ones `rows` was built with. */
  defaultOpen: string[]
  rows: PanelRow[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const str = (value: unknown): value is string => typeof value === 'string'
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const ICONS: readonly string[] = ['bookmarks', 'history', 'reading', 'downloads', 'extension']

export function asLimits (value: unknown): Limits | null {
  return isRecord(value) && num(value['min']) && num(value['max']) && num(value['reset']) ? { min: value['min'], max: value['max'], reset: value['reset'] } : null
}

export function asGuest (value: unknown): GuestMeta | null {
  if (!isRecord(value) || !str(value['id']) || !str(value['title'])) return null
  return { id: value['id'], title: value['title'], ...(str(value['icon']) ? { icon: value['icon'] } : {}) }
}

export function asGuests (value: unknown): GuestMeta[] {
  return Array.isArray(value) ? value.flatMap((entry) => { const guest = asGuest(entry); return guest === null ? [] : [guest] }) : []
}

function asView (value: unknown): ViewMeta | null {
  if (!isRecord(value)) return null
  const { id, title, icon, searchLabel, things, page, removable, empty } = value
  if (!str(id) || !str(title) || !str(icon) || !ICONS.includes(icon) || !str(searchLabel) || !str(things) || !str(empty) || typeof removable !== 'boolean') return null
  if (page !== null && !str(page)) return null
  return { id, title, icon: icon as PanelIcon, searchLabel, things, page, removable, empty }
}

export function asRows (value: unknown): PanelRow[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is PanelRow => isRecord(row) && str(row['id']) && str(row['title']) &&
    (row['kind'] === 'item' || row['kind'] === 'folder' || row['kind'] === 'header'))
}

export function asShown (payload: unknown): Shown | null {
  if (!isRecord(payload)) return null
  const { views, view, side, width, isPrivate } = payload
  const limits = asLimits(payload['limits'])
  if (!Array.isArray(views) || !str(view) || (side !== 'left' && side !== 'right') || !num(width) || limits === null || typeof isPrivate !== 'boolean') return null
  const metas = views.flatMap((entry) => { const meta = asView(entry); return meta === null ? [] : [meta] })
  return {
    views: metas, guests: asGuests(payload['guests']), view, guest: asGuest(payload['guest']), side, width, limits, isPrivate,
    defaultOpen: Array.isArray(payload['defaultOpen']) ? payload['defaultOpen'].filter(str) : [], rows: asRows(payload['rows'])
  }
}
