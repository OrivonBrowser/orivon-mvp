import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext, ChromeModule } from './context.js'
import { must } from './context.js'

/** Back, forward, reload and the address bar. */
export function createNavigation (): ChromeModule {
  let backBtn: HTMLButtonElement | undefined
  let forwardBtn: HTMLButtonElement | undefined
  let addressInput: HTMLInputElement | undefined
  /** True while the user is editing the address bar -- an incoming state push must not clobber what they are typing. */
  let addressFocused = false
  /** True from the person's first keystroke, paste or delete in the field until it is given an address again: a focused field nobody has typed in follows the page. */
  let edited = false
  /** The tab whose address the field was last given: an edit belongs to that tab. */
  let shownTabId: string | null = null
  /** While the field keeps an edit with the keyboard elsewhere (another app, the page): the page's address then. */
  let awayFrom: string | undefined

  function render (state: ShellState, ctx: ChromeContext): void {
    if (backBtn === undefined || forwardBtn === undefined || addressInput === undefined) return
    const active = ctx.activeTab()
    backBtn.disabled = active === undefined || !active.canGoBack
    forwardBtn.disabled = active === undefined || !active.canGoForward
    const address = active === undefined || active.isNewTab ? '' : active.displayUrl
    // Another tab in front, or the page moved on while the keyboard was away: the edit no longer belongs here.
    const switched = state.activeTabId !== shownTabId
    const movedOn = awayFrom !== undefined && awayFrom !== address
    shownTabId = state.activeTabId
    // A focused, untouched field already showing the address is left as it is, so a caret the person placed survives a title or icon push.
    if (addressFocused && !edited && !switched && !movedOn && addressInput.value === address) return
    if (!addressFocused || !edited || switched || movedOn) {
      addressInput.value = address
      edited = false
      if (awayFrom !== undefined) {
        awayFrom = undefined
        addressFocused = false
      } else if (addressFocused) addressInput.select()
    }
  }

  return {
    name: 'navigation',
    init: (ctx) => {
      const { shell } = ctx
      const back = must(document.querySelector<HTMLButtonElement>('#back'), '#back missing')
      const forward = must(document.querySelector<HTMLButtonElement>('#forward'), '#forward missing')
      const reload = must(document.querySelector<HTMLButtonElement>('#reload'), '#reload missing')
      const form = must(document.querySelector<HTMLFormElement>('#address-form'), '#address-form missing')
      const input = must(document.querySelector<HTMLInputElement>('#address'), '#address missing')
      backBtn = back
      forwardBtn = forward
      addressInput = input

      back.addEventListener('click', () => {
        const id = ctx.state()?.activeTabId
        if (id !== null && id !== undefined) shell.back(id)
      })
      forward.addEventListener('click', () => {
        const id = ctx.state()?.activeTabId
        if (id !== null && id !== undefined) shell.forward(id)
      })
      reload.addEventListener('click', () => {
        const id = ctx.state()?.activeTabId
        if (id !== null && id !== undefined) shell.reload(id)
      })

      input.addEventListener('focus', () => {
        addressFocused = true
        awayFrom = undefined
      })
      input.addEventListener('input', () => { edited = true })
      input.addEventListener('blur', () => {
        // The field is still the one the keyboard comes back to (Alt+Tab, a click into the page): the edit stays.
        if (document.activeElement === input) {
          const active = ctx.activeTab()
          awayFrom = active === undefined || active.isNewTab ? '' : active.displayUrl
          return
        }
        addressFocused = false
        edited = false
        const state = ctx.state()
        if (state !== null) render(state, ctx)
      })
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        const id = ctx.state()?.activeTabId
        if (id === null || id === undefined) return
        edited = false
        shell.navigate(id, input.value)
        input.blur()
      })
    },
    render,
    // A keyboard shortcut in main asks for the address bar.
    event: (payload) => {
      const event = payload as { type?: string, text?: unknown }
      // The search key gives the field a `?` with no key pressed in it: it is an edit, so a title or icon push before the first letter leaves it.
      if (event.type === 'focusSearch') edited = true
      if (event.type === 'focusAddress') {
        addressInput?.focus()
        addressInput?.select()
      }
      // The clipboard replaces the field and is submitted exactly as typed text is.
      if (event.type === 'pasteAndGo' && typeof event.text === 'string' && addressInput !== undefined) {
        addressInput.value = event.text
        addressInput.closest('form')?.requestSubmit()
      }
    }
  }
}
