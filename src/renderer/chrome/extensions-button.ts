import { puzzleIcon } from '../pages/shared/icons.js'
import type { ChromeContext, ChromeModule } from './context.js'

const MENU_OVERLAY = 'extensions-menu'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The Extensions button, left of Downloads and right of the extension icons: shown by `toolbar.extensions`,
 * and the one place the menu hangs from. Main tells it when the menu opens or closes (for `aria-expanded`),
 * and asks it to open the menu for the `extensions.menu` command so the menu anchors under the button. */
export function createExtensionsButton (): ChromeModule {
  let button: HTMLButtonElement | undefined

  function toggle (ctx: ChromeContext): void {
    // Hidden, the button has no place on screen: the menu hangs from the main menu's button instead.
    const anchorOn = button !== undefined && !button.hidden ? button : document.getElementById('menu')
    if (anchorOn === null) return
    const anchor = ctx.anchorFor(anchorOn)
    void ctx.shell.act('overlay.toggle', { name: MENU_OVERLAY, anchor, payload: { anchor } })
  }

  return {
    name: 'extensions-button',
    init: (ctx) => {
      const made = ctx.toolbarButton({
        id: 'extensions-menu-btn',
        slot: 'cluster',
        order: 5,
        label: 'Extensions',
        icon: puzzleIcon,
        onClick: () => { toggle(ctx) }
      })
      made.hidden = true
      made.setAttribute('aria-haspopup', 'menu')
      made.setAttribute('aria-expanded', 'false')
      button = made
    },
    render: (state) => {
      if (button !== undefined) button.hidden = !state.extensions.shown
    },
    event: (payload, ctx) => {
      if (!isRecord(payload)) return
      if (payload['type'] === 'open') toggle(ctx)
      else if (payload['type'] === 'expanded' && typeof payload['value'] === 'boolean') button?.setAttribute('aria-expanded', String(payload['value']))
    }
  }
}
