// The group bubble: a card under a group's chip to name it, colour it and act on it as a whole. Which group it
// shows is the one main was told to show; the page never sends an id.
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { GROUP_COLORS, MAX_GROUP_TITLE, groupsFor, isGroupColor } from './groups-model.js'
import type { GroupColor } from './groups-model.js'
import { closeGroup, membersOf, ungroupAll } from './groups-runner.js'
import { groupTab } from './groups-runner.js'
import { moveGroupToNewWindow } from './group-window.js'

export const TAB_GROUP_OVERLAY = 'tab-group'

/** What the page shows of the group. */
export interface GroupBubbleModel {
  readonly title: string
  readonly color: GroupColor
  readonly collapsed: boolean
  readonly count: number
  readonly colors: readonly GroupColor[]
  readonly maxTitle: number
  /** Another tab stays behind in this window, so the group can leave it. */
  readonly canMoveToWindow: boolean
}

export type GroupBubbleRequest =
  | { type: 'rename', title: string }
  | { type: 'color', color: GroupColor }
  | { type: 'newTab' }
  | { type: 'ungroup' }
  | { type: 'close' }
  | { type: 'toWindow' }

const SIMPLE: readonly string[] = ['newTab', 'ungroup', 'close', 'toWindow']

/** The request a page sent, or undefined for anything that is not one. */
export function asGroupRequest (command: unknown): GroupBubbleRequest | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, title, color } = command as Record<string, unknown>
  if (type === 'rename') return typeof title === 'string' ? { type, title: title.slice(0, MAX_GROUP_TITLE * 2) } : undefined
  if (type === 'color') return isGroupColor(color) ? { type, color } : undefined
  return typeof type === 'string' && SIMPLE.includes(type) ? { type } as GroupBubbleRequest : undefined
}

export const tabGroupOverlay: OverlayDef = {
  name: TAB_GROUP_OVERLAY,
  placement: { kind: 'anchor', width: 260, align: 'left' },
  surface: 'panel',
  focus: 'take',
  layer: 'popup',
  closeOn: CLOSE_LIKE_POPUP,
  keep: 'fresh',
  height: { initial: 250, min: 200, max: 320 },
  attach: (win) => {
    const { window } = win
    let shown: string | null = null
    const model = (): GroupBubbleModel | null => {
      const group = shown === null ? undefined : groupsFor(window.tabs).get(shown)
      if (group === undefined || shown === null) return null
      const count = membersOf(window.tabs, shown).length
      return { title: group.title, color: group.color, collapsed: group.collapsed, count, colors: GROUP_COLORS, maxTitle: MAX_GROUP_TITLE, canMoveToWindow: window.tabs.tabCount > count }
    }
    return {
      show: (payload) => {
        const id = (payload as { id?: unknown } | null)?.id
        shown = typeof id === 'string' && groupsFor(window.tabs).has(id) ? id : null
        const shownModel = model()
        if (shownModel === null) win.close()
        return shownModel
      },
      request: (command) => {
        const asked = asGroupRequest(command)
        const id = shown
        if (asked === undefined || id === null || !groupsFor(window.tabs).has(id)) return undefined
        switch (asked.type) {
          case 'rename': groupsFor(window.tabs).update(id, { title: asked.title }); return undefined
          case 'color': groupsFor(window.tabs).update(id, { color: asked.color }); return undefined
          case 'newTab': {
            win.close()
            if (!window.tabs.hasRoom()) return undefined
            const created = window.tabs.createTab()
            groupTab(win, created, id)
            return undefined
          }
          case 'ungroup': win.close(); ungroupAll(win, id); return undefined
          case 'close': win.close(); closeGroup(win, id); return undefined
          case 'toWindow': win.close(); moveGroupToNewWindow(win, id); return undefined
        }
      },
      closed: () => { shown = null }
    }
  }
}
