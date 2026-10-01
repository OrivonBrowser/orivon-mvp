import { isRect } from './overlay.js'
import type { ChromeAction } from '../chrome-actions.js'
import { groupsFor } from '../../tab-groups/groups-model.js'
import { moveGroup, toggleCollapsed } from '../../tab-groups/groups-runner.js'
import { TAB_GROUP_OVERLAY } from '../../tab-groups/tab-group-overlay.js'
import type { WindowContext } from '../window-context.js'

/** The id a chrome payload names, if it is a group this window has. The chrome can name any string. */
function groupOf (payload: unknown, { window }: WindowContext): string | undefined {
  const id = (payload as { id?: unknown } | null)?.id
  return typeof id === 'string' && groupsFor(window.tabs).has(id) ? id : undefined
}

/** `{ id }`: the chip was clicked: hides the group's tabs, or shows them. */
export const groupToggle: ChromeAction = (payload, ctx) => {
  const id = groupOf(payload, ctx)
  if (id !== undefined) toggleCollapsed(ctx, id)
}

/** `{ id, anchor }`: opens the group's bubble under its chip. */
export const groupMenu: ChromeAction = (payload, ctx) => {
  const id = groupOf(payload, ctx)
  const anchor = (payload as { anchor?: unknown }).anchor
  if (id !== undefined && isRect(anchor)) ctx.window.overlays.show(TAB_GROUP_OVERLAY, anchor, { id })
}

/** `{ id, index }`: the chip was dragged: moves the group to that place among the tabs outside it. */
export const groupMove: ChromeAction = (payload, ctx) => {
  const id = groupOf(payload, ctx)
  const index = (payload as { index?: unknown }).index
  if (id !== undefined && typeof index === 'number' && Number.isFinite(index)) moveGroup(ctx, id, index)
}
