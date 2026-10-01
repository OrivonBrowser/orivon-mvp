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

  function render (_state: ShellState, ctx: ChromeContext): void {
    if (backBtn === undefined || forwardBtn === undefined || addressInput === undefined) return
    const active = ctx.activeTab()
    backBtn.disabled = active === undefined || !active.canGoBack
    forwardBtn.disabled = active === undefined || !active.canGoForward
    if (!addressFocused) {
      addressInput.value = active === undefined || active.isNewTab ? '' : active.displayUrl
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

      input.addEventListener('focus', () => { addressFocused = true })
      input.addEventListener('blur', () => {
        addressFocused = false
        const state = ctx.state()
        if (state !== null) render(state, ctx)
      })
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        const id = ctx.state()?.activeTabId
        if (id === null || id === undefined) return
        shell.navigate(id, input.value)
        input.blur()
      })
    },
    render,
    // A keyboard shortcut in main asks for the address bar.
    event: (payload) => {
      const event = payload as { type?: string, text?: unknown }
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
