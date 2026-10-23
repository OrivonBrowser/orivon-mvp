// What a window an extension opens or moves is made of: its type, and where and how large it may be. The extension
// asks for numbers; the display decides what fits, by the same placement rules the shell's own windows follow
// (../window-state/placement.ts). No Electron runtime import: the displays arrive as arguments.
import { clamp, displayFor } from '../window-state/placement.js'
import type { Rect } from '../window-state/placement.js'

export interface Size { width: number, height: number }
export type { Rect }

/** Chrome's deprecated 'panel' is a popup there, and so here; 'app' and 'devtools' are ordinary shell windows. */
export function extensionWindowType (details: { type?: unknown }): 'normal' | 'popup' {
  return details.type === 'popup' || details.type === 'panel' ? 'popup' : 'normal'
}

type Request = { left?: unknown, top?: unknown, width?: unknown, height?: unknown }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** What the request names, as bounds: `left` is `x`, `top` is `y`. */
function asked (request: Request): Partial<Rect> {
  return {
    ...(finite(request.left) ? { x: Math.round(request.left) } : {}),
    ...(finite(request.top) ? { y: Math.round(request.top) } : {}),
    ...(finite(request.width) ? { width: Math.round(request.width) } : {}),
    ...(finite(request.height) ? { height: Math.round(request.height) } : {})
  }
}

/** `wanted` made to fit the display it overlaps most: the size between `min` and the display, the corner back inside it. */
function fit (wanted: Rect, areas: readonly Rect[], min: Size): Rect {
  const area = displayFor(wanted, areas)
  const width = Math.round(clamp(wanted.width, min.width, area?.width ?? wanted.width))
  const height = Math.round(clamp(wanted.height, min.height, area?.height ?? wanted.height))
  if (area === undefined) return { x: wanted.x, y: wanted.y, width, height }
  return {
    x: Math.round(clamp(wanted.x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(wanted.y, area.y, area.y + area.height - height)),
    width,
    height
  }
}

/**
 * The bounds a `windows.create` call opens a window with, or `{}` when it asked for none (the shell's defaults then
 * decide). `areas` lists the primary display first; `size` is the size a window gets when it is given none, so a
 * corner is held inside the display for the window that will really open there. A size with no place is centred on the
 * primary display, as the shell centres its own windows.
 */
export function placeExtensionWindow (request: Request, areas: readonly Rect[], min: Size, size: Size): Partial<Rect> {
  const given = asked(request)
  if (Object.keys(given).length === 0) return {}
  const width = given.width ?? size.width
  const height = given.height ?? size.height
  const primary = areas[0]
  if (primary === undefined) {
    return { ...given, ...(given.width !== undefined ? { width: Math.max(min.width, width) } : {}), ...(given.height !== undefined ? { height: Math.max(min.height, height) } : {}) }
  }
  return fit({
    x: given.x ?? primary.x + Math.round((primary.width - width) / 2),
    y: given.y ?? primary.y + Math.round((primary.height - height) / 2),
    width,
    height
  }, areas, min)
}

/**
 * The bounds `windows.update` moves a window to, or undefined when the call names none of left, top, width and height.
 * Only the sides the call names change: a window the person put across two displays keeps the rest of its place.
 */
export function updatedBounds (request: Request, areas: readonly Rect[], min: Size, current: Rect): Rect | undefined {
  const given = asked(request)
  const named = Object.keys(given) as Array<keyof Rect>
  if (named.length === 0) return undefined
  const fitted = fit({ ...current, ...given }, areas, min)
  const next: Rect = { ...current }
  for (const key of named) next[key] = fitted[key]
  return next
}
