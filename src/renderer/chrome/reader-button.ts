import type { ShellState } from '../../main/shell/tabs.js'
import { bookOpenIcon } from '../pages/shared/icons.js'
import { formatKeys } from '../overlay/menu/keys.js'
import type { ChromeContext, ChromeModule } from './context.js'

/** A book in the address pill while the page in front looks like an article; a click opens reader view. */
export function createReaderButton (): ChromeModule {
  let button: HTMLButtonElement | undefined
  return {
    name: 'reader',
    init: (ctx: ChromeContext) => {
      button = ctx.toolbarButton({
        id: 'reader',
        slot: 'address',
        order: 30,
        label: 'Open reader view',
        icon: bookOpenIcon,
        onClick: () => { ctx.shell.runCommand('page.reader') }
      })
      button.hidden = true
    },
    render: (state: ShellState, ctx: ChromeContext) => {
      if (button === undefined) return
      button.hidden = ctx.activeTab()?.readable !== true
      // The binding can be changed in Settings, so the tooltip names the one that runs now.
      const keys = state.shortcutKeys['page.reader']
      const label = keys === null ? 'Open reader view' : `Open reader view (${formatKeys(keys, document.documentElement.dataset['platform'] ?? '')})`
      button.title = label
      button.setAttribute('aria-label', 'Open reader view')
    }
  }
}
