import type { TabState } from '../../main/shell/tabs.js'
import type { ShellState } from '../../main/shell/tabs.js'
import { h } from '../pages/shared/dom.js'
import { warningIcon } from '../pages/shared/icons.js'
import { formatAddress } from './address-format.js'
import type { ChromeContext, ChromeModule } from './context.js'
import { must } from './context.js'

const INSECURE_TITLE = 'This site does not use a secure connection. Do not enter passwords or card numbers.'

/** The connection mark, or nothing: a warning only for plain http to a public host. A secure connection is not drawn as
 * a third glyph beside the shield and the site button: the site button's title says it, and so does its popover. */
function markFor (tab: TabState): HTMLElement | undefined {
  if (tab.connection === 'insecure') {
    return h('span', { className: 'address-mark insecure', title: INSECURE_TITLE, ariaLabel: `Not secure. ${INSECURE_TITLE}` },
      warningIcon(), h('span', { className: 'address-mark-label', ariaHidden: 'true' }, 'Not secure'))
  }
  return undefined
}

/** What the unfocused address bar shows over the input: the connection mark and the address in two tones. The
 * input keeps the real value and stays under it, so typing, pasting, copying and tests all still act on it. */
export function createAddressDisplay (): ChromeModule {
  let display: HTMLElement | undefined
  let field: HTMLElement | undefined

  function render (state: ShellState, ctx: ChromeContext): void {
    if (display === undefined || field === undefined) return
    const tab = ctx.activeTab()
    if (tab === undefined || tab.isNewTab || tab.displayUrl === '') {
      field.dataset['elided'] = 'false'
      display.replaceChildren()
      return
    }
    const parts = formatAddress(tab.displayUrl, { full: state.showFullUrl === true })
    // What comes before the site's own name (a scheme, a subdomain) is shortened from its left, and what comes after from its
    // right, so the name itself is always in view.
    const nameAt = parts.findIndex((part) => part.fixed === true)
    const text = h('span', { className: 'address-text', ariaHidden: 'true' },
      ...parts.map((part, index) => {
        if (part.tone === 'strong') return h('span', { className: part.fixed === true ? 'address-host fixed' : 'address-host' }, part.text)
        if (nameAt !== -1 && index < nameAt) return h('span', { className: 'address-rest lead' }, h('bdo', { dir: 'ltr' }, part.text))
        return h('span', { className: 'address-rest' }, part.text)
      }))
    display.replaceChildren(...[markFor(tab), text].filter((node): node is HTMLElement => node !== undefined))
    field.dataset['elided'] = 'true'
  }

  return {
    name: 'addressDisplay',
    init: (ctx) => {
      const input = must(document.querySelector<HTMLInputElement>('#address'), '#address missing')
      // The input and the display share one box, so the display is sized by the room the input has.
      const box = h('div', { className: 'address-field' })
      input.before(box)
      box.append(input)
      display = h('div', { id: 'address-display', className: 'address-display' })
      box.append(display)
      field = box
      box.dataset['elided'] = 'false'

      // A press on the mark is a press on the bar: it has a tooltip, so it takes pointer events the text does not.
      display.addEventListener('mousedown', (event) => {
        event.preventDefault()
        input.focus()
        input.select()
      })

      // The first press on the unfocused bar selects the whole address; a second places the caret.
      let pressedWhileBlurred = false
      input.addEventListener('mousedown', () => { pressedWhileBlurred = document.activeElement !== input })
      input.addEventListener('mouseup', (event) => {
        if (!pressedWhileBlurred) return
        pressedWhileBlurred = false
        event.preventDefault()
        input.select()
      })
      // Tab and the shortcuts arrive with no press: they select too.
      input.addEventListener('focus', () => { if (!pressedWhileBlurred) input.select() })
      // Escape gives the page's address back, hands the bar to the display and the keyboard to the page. A key another
      // feature already used (closing a list under the bar), or one an input method is composing with, is not a request to leave.
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
        input.blur()
        void ctx.shell.act('pane.leave', { to: 'page' })
      })
    },
    render
  }
}
