import type { ShellState } from '../../main/shell/tabs.js'
import { homeIcon } from '../pages/shared/icons.js'
import { formatKeys } from '../overlay/menu/keys.js'
import type { ChromeContext, ChromeModule } from './context.js'

/** The Home button, right of Reload; shown only while `toolbar.home` is on. A click loads the home page here; a
 * middle click or a Mod click opens it in a new background tab. */
export function createHomeButton (): ChromeModule {
  let button: HTMLButtonElement | undefined

  function open (ctx: ChromeContext, newTab: boolean): void {
    void ctx.shell.act('home.open', { newTab })
  }

  return {
    name: 'home',
    init: (ctx) => {
      const home = ctx.toolbarButton({
        id: 'home',
        slot: 'nav',
        order: 10,
        label: 'Home',
        icon: homeIcon,
        onClick: (_el, event) => { open(ctx, event.ctrlKey || event.metaKey) }
      })
      home.title = 'Home'
      home.hidden = true
      // A middle press would start Chromium's autoscroll before the release that opens the tab.
      home.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
      home.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return
        event.preventDefault()
        open(ctx, true)
      })
      button = home
    },
    render: (state: ShellState) => {
      if (button === undefined) return
      button.hidden = !state.homeButton
      // The binding can be changed in Settings, so the tooltip names the one that runs now.
      const keys = state.shortcutKeys['nav.home']
      button.title = keys === null ? 'Home' : `Home (${formatKeys(keys, document.documentElement.dataset['platform'] ?? '')})`    }
  }
}
