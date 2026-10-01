// The main menu as an overlay: a warm card under the toolbar's menu button,
// listing what ./menu-layout.ts lays out and running the command a row names.
import { isCommandId } from '../shortcuts/commands.js'
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { menuItems, runnableIds } from './menu-layout.js'

const MENU_WIDTH = 380

interface RunRequest { type: 'run', id: string, stay?: boolean }

function asRunRequest (command: unknown): RunRequest | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, id, stay } = command as Record<string, unknown>
  if (type !== 'run' || typeof id !== 'string') return undefined
  if (stay !== undefined && typeof stay !== 'boolean') return undefined
  return stay === undefined ? { type, id } : { type, id, stay }
}

export const menuOverlay: OverlayDef = {
  name: 'menu',
  placement: { kind: 'anchor', width: MENU_WIDTH, align: 'right' },
  surface: 'menu',
  focus: 'take',
  layer: 'popup',
  closeOn: CLOSE_LIKE_POPUP,
  // The card is built ahead of the click by the button's hover (prewarm), so opening it costs no renderer start.
  keep: 'warm',
  // Every entry shows: the only cap is the room below the toolbar.
  height: { initial: 400, max: Number.POSITIVE_INFINITY },
  attach: (win) => {
    const { window, services } = win
    return {
      // Re-read on every show: a remapped key or a changed zoom shows at once.
      show: () => menuItems(win),
      request: (command) => {
        const request = asRunRequest(command)
        if (request === undefined) return undefined
        // Only what the menu lists now, never any command the registry has.
        const listed = menuItems(win)
        if (!isCommandId(request.id) || !runnableIds(listed).has(request.id)) return undefined
        if (request.stay !== true) win.close()
        services.commands.run(request.id, window)
        return request.stay === true ? menuItems(win) : undefined
      }
    }
  }
}
