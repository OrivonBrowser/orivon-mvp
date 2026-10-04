import { chevronDownIcon } from '../pages/shared/icons.js'
import { formatKeys } from '../overlay/menu/keys.js'
import type { ChromeModule } from './context.js'
import { must } from './context.js'

/** The button at the strip's right end that opens tab search. It sits after the empty tail, so it stays at the
 * far end however many tabs there are, and inside the room the strip keeps for the native window buttons. */
export function createTabSearchButton (): ChromeModule {
  let button: HTMLButtonElement | undefined
  return {
    name: 'tab-search',
    init: (ctx) => {
      const row = must(document.getElementById('tabrow'), '#tabrow missing')
      button = document.createElement('button')
      button.id = 'tab-search'
      button.type = 'button'
      button.className = 'tab-search-btn no-drag'
      button.title = 'Search tabs'
      button.setAttribute('aria-label', 'Search tabs')
      button.setAttribute('aria-haspopup', 'listbox')
      button.append(chevronDownIcon())
      const self = button
      button.addEventListener('pointerdown', (event) => { if (event.button === 0) ctx.shell.press('tab-search') })
      button.addEventListener('click', () => {
        void ctx.shell.act('overlay.toggle', { name: 'tab-search', anchor: ctx.anchorFor(self) })
      })
      row.append(button)
    },
    // The binding can be changed in Settings, so the tooltip names the one that runs now.
    render: (state) => {
      if (button === undefined) return
      const keys = state.shortcutKeys['tab.search']
      button.title = keys === null ? 'Search tabs' : `Search tabs (${formatKeys(keys, document.documentElement.dataset['platform'] ?? '')})`
    }
  }
}
