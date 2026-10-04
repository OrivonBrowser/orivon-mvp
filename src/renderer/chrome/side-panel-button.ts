import type { ShellState } from '../../main/shell/tabs.js'
import { formatKeys } from '../overlay/menu/keys.js'
import { panelLeftIcon, panelRightIcon } from '../pages/shared/icons.js'
import type { ChromeModule } from './context.js'

/** The cluster's side panel button: pressed while the panel is open, drawn on the side the panel docks to, and
 * disabled in a window too narrow to hold one. */
export function createSidePanelButton (): ChromeModule {
  let button: HTMLButtonElement | undefined
  let drawnSide: 'left' | 'right' | null = null
  let latest: ShellState | null = null

  function paint (state: ShellState): void {
    if (button === undefined) return
    const panel = state.sidePanel
    const side = panel?.side ?? 'right'
    if (side !== drawnSide) {
      drawnSide = side
      button.replaceChildren(side === 'left' ? panelLeftIcon() : panelRightIcon())
    }
    // The body's width, not the view's: the view is wider than the window while a tab is pressed (native-tab-drag.ts).
    const narrow = document.body.clientWidth < (panel?.minWindow ?? 0)
    button.disabled = narrow
    const shown = panel?.open === true && !narrow
    button.setAttribute('aria-pressed', String(shown))
    button.classList.toggle('active', shown)
    // The binding can be changed in Settings, so the tooltip names the one that runs now.
    const keys = state.shortcutKeys['sidePanel.toggle']
    const base = keys === null ? 'Side panel' : `Side panel (${formatKeys(keys, document.documentElement.dataset['platform'] ?? '')})`
    button.title = narrow ? 'Widen the window to use the side panel' : base
  }

  return {
    name: 'side-panel',
    init: (ctx) => {
      button = ctx.toolbarButton({
        id: 'side-panel',
        slot: 'cluster',
        order: 20,
        label: 'Side panel',
        icon: panelRightIcon,
        onClick: () => { ctx.shell.runCommand('sidePanel.toggle') }
      })
      button.setAttribute('aria-pressed', 'false')
      window.addEventListener('resize', () => { if (latest !== null) paint(latest) })
    },
    render: (state) => {
      latest = state
      paint(state)
    }
  }
}
