import type { ChromeAction } from '../chrome-actions.js'

/** The two calls of the overlay host these actions use. Declared here, structurally, so the actions do not
 * depend on the host's module: a window with no overlay host ignores them. */
export interface OverlayControls {
  toggle: (name: string, anchor?: OverlayRect, payload?: unknown) => void
  close: (name?: string) => void
}

interface OverlayRect { x: number, y: number, width: number, height: number }

function isRect (value: unknown): value is OverlayRect {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Record<string, unknown>
  return [rect['x'], rect['y'], rect['width'], rect['height']].every((n) => typeof n === 'number' && Number.isFinite(n))
}

function controlsOf (window: object): OverlayControls | undefined {
  return (window as { overlays?: OverlayControls }).overlays
}

function nameOf (payload: unknown): string | undefined {
  const name = (payload as { name?: unknown } | null)?.name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

/** `{ name, anchor?, payload? }`: opens the overlay, or closes it if it is already open. `anchor` is the
 * chrome-side rectangle of the control that asked; the overlay's own handler validates `payload`. */
export const overlayToggle: ChromeAction = (payload, { window }) => {
  const name = nameOf(payload)
  if (name === undefined) return
  const { anchor, payload: forwarded } = payload as { anchor?: unknown, payload?: unknown }
  if (anchor === undefined) controlsOf(window)?.toggle(name, undefined, forwarded)
  else if (isRect(anchor)) controlsOf(window)?.toggle(name, anchor, forwarded)
}

/** `{ name }`: closes that overlay. */
export const overlayClose: ChromeAction = (payload, { window }) => {
  const name = nameOf(payload)
  if (name === undefined) return
  controlsOf(window)?.close(name)
}
