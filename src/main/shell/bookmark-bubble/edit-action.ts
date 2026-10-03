// The chrome's call that opens the bubble: the star's click and the answer to Mod+D (both carry the star's
// rectangle), and a bar item's menu. Each field comes from a renderer and is checked here.
import type { OverlayAnchor } from '../../overlays/overlay-types.js'
import type { ChromeAction } from '../chrome-actions.js'
import { openBookmarkEdit } from './open-edit.js'

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function asAnchor (value: unknown): OverlayAnchor | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { x, y, width, height } = value as Record<string, unknown>
  return isNumber(x) && isNumber(y) && isNumber(width) && isNumber(height) ? { x, y, width, height } : undefined
}

const MODES = ['edit', 'rename-folder', 'new-folder'] as const

/** `{ anchor?, add?, toggle?, id?, mode? }`. No id: the active page's bookmark (made first when `add`). */
export const bookmarkEdit: ChromeAction = (payload, ctx) => {
  if (typeof payload !== 'object' || payload === null) return
  const { anchor, add, toggle, id, mode } = payload as Record<string, unknown>
  if (id !== undefined && typeof id !== 'string') return
  if (mode !== undefined && !(MODES as readonly unknown[]).includes(mode)) return
  openBookmarkEdit(ctx, {
    anchor: asAnchor(anchor),
    id,
    mode: mode as (typeof MODES)[number] | undefined,
    add: add === true,
    toggle: toggle === true,
    pressedAt: toggle === true ? ctx.takePress?.('bookmark-edit') : undefined
  })
}
