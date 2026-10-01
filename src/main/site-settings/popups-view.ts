// What the pop-up bubble shows and the commands it may send. Pure: main builds
// the view from its own record of what the page tried to open, and the page
// only draws it and names a row by position, never by address.
import { formatOriginForDisplay } from '../consent/grant-prompt-origin.js'

/** The most addresses listed; the rest are counted. */
export const MAX_LISTED = 10

export interface PopupRow {
  /** Where the window was going, as a person reads it. */
  readonly host: string
  /** The whole address: shown in full on hover and ellipsised in the row. */
  readonly url: string
}

export interface PopupsView {
  readonly origin: string
  readonly rows: readonly PopupRow[]
  /** Blocked addresses past the ones listed. */
  readonly more: number
  /** The site is allowed to open pop-ups now. */
  readonly allowed: boolean
  /** Site settings has a page to open. */
  readonly settingsLink: boolean
}

export type PopupsCommand =
  | { readonly type: 'open', readonly index: number }
  | { readonly type: 'apply', readonly allow: boolean }
  | { readonly type: 'settings' }

function hostOf (url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** `urls` newest first, as `PopupBlocks.list` returns them. */
export function popupsView (origin: string, urls: readonly string[], allowed: boolean, settingsLink: boolean): PopupsView {
  return {
    origin: formatOriginForDisplay(origin),
    rows: urls.slice(0, MAX_LISTED).map((url) => ({ host: hostOf(url), url })),
    more: Math.max(0, urls.length - MAX_LISTED),
    allowed,
    settingsLink
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Only the fixed shapes, with no extra keys: anything else is not a command of this bubble. */
export function asPopupsCommand (command: unknown): PopupsCommand | undefined {
  if (!isRecord(command)) return undefined
  const { type, ...rest } = command
  const keys = Object.keys(rest).sort().join(',')
  if (type === 'settings' && keys === '') return { type }
  if (type === 'apply' && keys === 'allow') return typeof rest['allow'] === 'boolean' ? { type, allow: rest['allow'] } : undefined
  if (type === 'open' && keys === 'index') {
    const { index } = rest
    return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < MAX_LISTED ? { type, index } : undefined
  }
  return undefined
}
