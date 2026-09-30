import { chevronDownIcon } from '../pages/shared/icons.js'
import type { ChromeModule } from './context.js'
import { must } from './context.js'

/** The key as the platform writes it, for the tooltip. The command's binding can be changed in Settings, so this
 * names the default. */
function keyHint (platform: string | undefined): string {
  return platform === 'darwin' ? '⌘⇧A' : 'Ctrl+Shift+A'
}

/** The button at the strip's right end that opens tab search. It sits after the empty tail, so it stays at the
 * far end however many tabs there are, and inside the room the strip keeps for the native window buttons. */
export function createTabSearchButton (): ChromeModule {
  return {
    name: 'tab-search',
    init: (ctx) => {
      const row = must(document.getElementById('tabrow'), '#tabrow missing')
      const button = document.createElement('button')
      button.id = 'tab-search'
      button.type = 'button'
      button.className = 'tab-search-btn no-drag'
      const label = `Search tabs (${keyHint(document.documentElement.dataset['platform'])})`
      button.title = label
      button.setAttribute('aria-label', 'Search tabs')
      button.setAttribute('aria-haspopup', 'listbox')
      button.append(chevronDownIcon())
      button.addEventListener('click', () => {
        void ctx.shell.act('overlay.toggle', { name: 'tab-search', anchor: ctx.anchorFor(button) })
      })
      row.append(button)
    }
  }
}
