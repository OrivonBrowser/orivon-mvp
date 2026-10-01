// What the Extensions menu shows and asks, as data -- pure: no `electron`.
// `extensions-menu-overlay.ts` fills it from the host and the stores, and the
// page in src/renderer/overlay/extensions-menu/ draws it.
import { sortRows } from './action-pins.js'

export interface MenuRow {
  readonly id: string
  readonly name: string
  /** A `data:` URL `readExtensionFacts` already read, or null when the manifest names no icon. */
  readonly icon: string | null
  readonly pinned: boolean
  /** The extension has a toolbar action to run. Without one the row opens its details instead. */
  readonly hasAction: boolean
  readonly hasOptions: boolean
  /** The badge text the extension shows on the active tab, or ''. */
  readonly badge: string
  /** What each feature adds for its own line (`EXTENSION_MENU_ROW_PARTS`). */
  readonly parts: Readonly<Record<string, unknown>>
}

export interface MenuPayload {
  /** The active tab's host while it shows a site, else null. */
  readonly site: string | null
  /** False on a page no extension can act on (a Orivon page): rows then only manage. */
  readonly activatable: boolean
  readonly rows: readonly MenuRow[]
}

export interface MenuEntry {
  readonly id: string
  readonly name: string
  readonly icon: string | null
  readonly optionsUrl: string | undefined
}

export interface ActionInfo { readonly hasPopup: boolean, readonly badge: string }

export interface Rect { readonly x: number, readonly y: number, readonly width: number, readonly height: number }

const EXTENSION_ID = /^[a-p]{32}$/

export function isExtensionId (value: unknown): value is string {
  return typeof value === 'string' && EXTENSION_ID.test(value)
}

export function buildRows (
  entries: readonly MenuEntry[],
  actions: ReadonlyMap<string, ActionInfo>,
  pinned: (id: string) => boolean,
  parts: (id: string) => Readonly<Record<string, unknown>>
): MenuRow[] {
  return sortRows(entries.map((entry): MenuRow => {
    const action = actions.get(entry.id)
    return {
      id: entry.id,
      name: entry.name,
      icon: entry.icon,
      pinned: action !== undefined && pinned(entry.id),
      hasAction: action !== undefined,
      hasOptions: entry.optionsUrl !== undefined,
      badge: action?.badge ?? '',
      parts: parts(entry.id)
    }
  }))
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A request from the page: a string `type` and the rest of the object. Anything else is ignored. */
export function asRequest (command: unknown): { type: string, body: Record<string, unknown> } | undefined {
  if (!isRecord(command) || typeof command['type'] !== 'string') return undefined
  return { type: command['type'], body: command }
}

/** The rectangle the chrome passed with the show, or undefined when it is missing or not four finite numbers. */
export function anchorFrom (payload: unknown): Rect | undefined {
  const anchor = isRecord(payload) ? payload['anchor'] : undefined
  if (!isRecord(anchor)) return undefined
  const { x, y, width, height } = anchor
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

/** Where a popup hangs when the menu was opened without a button to measure: under the toolbar's right end. */
export function fallbackAnchor (contentWidth: number): Rect {
  return { x: Math.max(0, contentWidth - 112), y: 40, width: 32, height: 32 }
}

/** The host of a page a person is on, for the heading; null for an internal page, a blank tab or an address that is no site. */
export function siteHost (url: string | undefined, shown: boolean): string | null {
  if (url === undefined || !shown) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : null
  } catch {
    return null
  }
}

/** `chrome-extension://<id>/<page>` for the manifest's options page, or undefined when it names none (or names a place outside the extension). */
export function optionsPageUrl (id: string, manifest: unknown): string | undefined {
  if (!isRecord(manifest)) return undefined
  const ui = manifest['options_ui']
  const page = typeof manifest['options_page'] === 'string'
    ? manifest['options_page']
    : isRecord(ui) && typeof ui['page'] === 'string' ? ui['page'] : undefined
  if (page === undefined || page === '') return undefined
  try {
    const resolved = new URL(page, `chrome-extension://${id}/`)
    return resolved.protocol === 'chrome-extension:' && resolved.hostname === id ? resolved.href : undefined
  } catch {
    return undefined
  }
}
