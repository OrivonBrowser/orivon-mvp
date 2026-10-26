import type { ShellState, TabState } from '../../main/shell/tabs.js'
import type { ChromeContext, ChromeModule } from './context.js'
import { must } from './context.js'

/** What the field shows for a page when nothing is typed: a start page has no address. */
const addressOf = (tab: TabState | undefined): string => tab === undefined || tab.isNewTab ? '' : tab.displayUrl

/** Whether the text is something the person wrote: a blank field, or the page's own address, is not. */
const isEdit = (text: string, address: string): boolean => text.trim() !== '' && text !== address

/** What a tab in the background had in the field: the text, and the address of its page when the person left it. */
interface Draft { text: string, at: string }

/** Back, forward, reload and the address bar. */
export function createNavigation (): ChromeModule {
  let backBtn: HTMLButtonElement | undefined
  let forwardBtn: HTMLButtonElement | undefined
  let addressInput: HTMLInputElement | undefined
  /** True while the user is editing the address bar -- an incoming state push must not clobber what they are typing. */
  let addressFocused = false
  /** True from the person's first keystroke, paste or delete in the field until it is given an address again: a focused field nobody has typed in follows the page. An edit stays in the field when the field is left. */
  let edited = false
  /** The tab whose address the field was last given: an edit belongs to that tab. */
  let shownTabId: string | null = null
  /** While the field keeps an edit with nobody typing in it (the keyboard in another app, the page or elsewhere in the chrome): the page's address then. */
  let awayFrom: string | undefined
  /** The edit of each tab that is not in front. The one in front is in the field. */
  const drafts = new Map<string, Draft>()

  /** Tells the style sheet that the field holds an edit, which it shows in place of the elided address. */
  function markDraft (ctx: ChromeContext): void {
    if (addressInput === undefined) return
    addressInput.dataset['draft'] = String(edited && isEdit(addressInput.value, addressOf(ctx.activeTab())))
  }

  function setEdited (on: boolean, ctx: ChromeContext): void {
    edited = on
    markDraft(ctx)
  }

  /** Puts the field's edit with the tab it was made on, as the front changes. */
  function keepEdit (state: ShellState): void {
    const tab = shownTabId === null ? undefined : state.tabs.find((candidate) => candidate.id === shownTabId)
    if (tab === undefined || addressInput === undefined || !edited) return
    const at = addressOf(tab)
    // The page moved on while the keyboard was away: the text is about a page that is gone.
    if (awayFrom !== undefined && awayFrom !== at) return
    if (isEdit(addressInput.value, at)) drafts.set(tab.id, { text: addressInput.value, at })
  }

  /** Drops the edit of a tab that is closed or whose page moved on. */
  function forgetStale (state: ShellState): void {
    for (const [id, draft] of drafts) {
      const tab = state.tabs.find((candidate) => candidate.id === id)
      if (tab === undefined || addressOf(tab) !== draft.at) drafts.delete(id)
    }
  }

  function render (state: ShellState, ctx: ChromeContext): void {
    if (backBtn === undefined || forwardBtn === undefined || addressInput === undefined) return
    const active = ctx.activeTab()
    backBtn.disabled = active === undefined || !active.canGoBack
    forwardBtn.disabled = active === undefined || !active.canGoForward
    const address = addressOf(active)
    // Another tab in front: the edit stays with the tab it was made on, and this tab's own comes back.
    const switched = state.activeTabId !== shownTabId
    if (switched) keepEdit(state)
    forgetStale(state)
    // The page moved on while the keyboard was away: the edit no longer belongs here.
    const movedOn = !switched && awayFrom !== undefined && awayFrom !== address
    shownTabId = state.activeTabId
    // A focused, untouched field already showing the address is left as it is, so a caret the person placed survives a title or icon push.
    if (addressFocused && !edited && !switched && !movedOn && addressInput.value === address) return
    if (!edited || switched || movedOn) {
      const draft = switched && state.activeTabId !== null ? drafts.get(state.activeTabId) : undefined
      if (draft !== undefined && state.activeTabId !== null) drafts.delete(state.activeTabId)
      addressInput.value = draft?.text ?? address
      setEdited(draft !== undefined, ctx)
      if (awayFrom !== undefined) {
        awayFrom = undefined
        addressFocused = false
      }
      if (draft !== undefined) {
        // With the keyboard in the field the edit is being typed in again, and a caret after it cannot replace it by accident; without, it waits for the page to move on.
        if (addressFocused) addressInput.setSelectionRange(draft.text.length, draft.text.length)
        else awayFrom = address
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
      input.addEventListener('input', () => { setEdited(true, ctx) })
      // The page's own address is not part of the edit, so a choice made in the dropdown ends it as a submit does.
      input.addEventListener('address-chosen', () => { setEdited(false, ctx) })
      input.addEventListener('blur', () => {
        const here = addressOf(ctx.activeTab())
        // The field is still the one the keyboard comes back to (Alt+Tab, a click into the page): the edit stays.
        if (document.activeElement === input) {
          awayFrom = here
          return
        }
        addressFocused = false
        // Left for something else in the chrome: a real edit stays with its tab, and anything else follows the page.
        if (edited && isEdit(input.value, here)) {
          awayFrom = here
          return
        }
        setEdited(false, ctx)
        const state = ctx.state()
        if (state !== null) render(state, ctx)
      })
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        const id = ctx.state()?.activeTabId
        if (id === null || id === undefined) return
        setEdited(false, ctx)
        shell.navigate(id, input.value)
        input.blur()
      })
    },
    render,
    // A keyboard shortcut in main asks for the address bar.
    event: (payload, ctx) => {
      const event = payload as { type?: string, text?: unknown }
      // The search key gives the field a `?` with no key pressed in it: it is an edit, so a title or icon push before the first letter leaves it.
      if (event.type === 'focusSearch') setEdited(true, ctx)
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
