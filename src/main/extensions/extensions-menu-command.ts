// What the `extensions.menu` command does: close the menu if it is open, else
// ask the chrome to open it under its Extensions button (or the toolbar's end
// when the button is hidden), so a popup an extension opens hangs from there.
import { sendChromeEvent } from '../shell/shell-events.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { EXTENSIONS_BUTTON_MODULE, EXTENSIONS_MENU_OVERLAY } from './extensions-menu-names.js'

/** A private window that runs no extension (none was allowed there) has no menu to open. */
export function toggleExtensionsMenu (target: ShellWindow, runsNone: boolean): void {
  if (target.overlays.isOpen(EXTENSIONS_MENU_OVERLAY)) {
    target.overlays.close(EXTENSIONS_MENU_OVERLAY)
    return
  }
  if (!runsNone) sendChromeEvent(target, EXTENSIONS_BUTTON_MODULE, { type: 'open' })
}
