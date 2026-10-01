import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext, ChromeModule, TabDecorator } from './context.js'
import { must } from './context.js'
import { attachRoving, canFocus, syncStops } from './roving-dom.js'

type ChromePane = 'address' | 'toolbar' | 'tabs' | 'bookmarks'

const LABELS: Readonly<Record<ChromePane, string>> = { address: 'Address bar', toolbar: 'Toolbar', tabs: 'Tabs', bookmarks: 'Bookmarks bar' }

/** What a pane's keyboard stop can be in the tab strip: a tab, a group chip, or one of the buttons at its ends. */
const STRIP_ITEMS = '.tab, .tab-group-chip, #new-tab, #tab-search'

const PANE_NAMES: readonly string[] = ['address', 'toolbar', 'tabs', 'bookmarks']
const isPane = (value: unknown): value is ChromePane => typeof value === 'string' && PANE_NAMES.includes(value)

const stripKey = (el: HTMLElement): string => el.dataset['id'] ?? el.dataset['groupId'] ?? el.id

/**
 * The chrome's parts as panes the keyboard moves between (F6 and Shift+F6, decided in main: src/main/focus/), and
 * the arrow keys inside two of them. The toolbar and the tab strip each hold one Tab stop, the one that last had
 * focus; the decorator keeps the strip's stop right across its rebuilds.
 */
export function createPanes (): { module: ChromeModule, decorator: TabDecorator } {
  let ctxRef: ChromeContext | undefined
  let toolbar: HTMLElement | undefined
  let tabrow: HTMLElement | undefined
  let bookmarks: HTMLElement | undefined
  let address: HTMLInputElement | undefined
  let live: HTMLElement | undefined
  let announceTimer: ReturnType<typeof setTimeout> | undefined
  let toolbarStop: HTMLElement | undefined
  /** The strip item that holds its Tab stop, by `stripKey`; the active tab until the person moves in the strip. */
  let stripStop: string | null = null
  /** Keyboard focus is in the strip: a rebuild that drops the focused element puts it back. */
  let stripHasFocus = false
  let shownActive: string | null = null

  const toolbarItems = (): HTMLElement[] => {
    const all = toolbar === undefined ? [] : [...toolbar.querySelectorAll<HTMLElement>('button')]
    // The address pill's own buttons stay in the Tab order after the field; the row holds the rest.
    return all.filter((el) => el.closest('#address-form') === null).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
  }
  const stripItems = (): HTMLElement[] => tabrow === undefined ? [] : [...tabrow.querySelectorAll<HTMLElement>(STRIP_ITEMS)].filter((el) => !el.hidden)
  const bookmarkStop = (): HTMLElement | undefined => {
    if (bookmarks === undefined || document.documentElement.dataset['bookmarks'] === 'none') return undefined
    const stops = [...bookmarks.querySelectorAll<HTMLElement>('button')].filter(canFocus)
    return stops.find((el) => el.tabIndex === 0) ?? stops[0]
  }

  function announce (text: string): void {
    if (live === undefined) return
    const region = live
    if (announceTimer !== undefined) clearTimeout(announceTimer)
    region.textContent = ''
    announceTimer = setTimeout(() => { region.textContent = text }, 60)
  }

  function stripStopElement (state: ShellState | null): HTMLElement | undefined {
    const items = stripItems()
    const wanted = stripStop ?? state?.activeTabId ?? null
    return items.find((el) => wanted !== null && stripKey(el) === wanted && canFocus(el)) ?? items.find((el) => el.classList.contains('active') && canFocus(el)) ?? items.find(canFocus)
  }

  /** Every item but the stop leaves the Tab order; a tab's own buttons are never stops. */
  function syncStrip (state: ShellState | null): void {
    const stop = stripStopElement(state)
    for (const el of stripItems()) {
      el.tabIndex = el === stop ? 0 : -1
      for (const inner of el.querySelectorAll<HTMLElement>('button')) inner.tabIndex = -1
    }
  }

  const decorator: TabDecorator = (el, tab, state) => {
    el.tabIndex = tab.id === (stripStop ?? state.activeTabId) ? 0 : -1
    for (const inner of el.querySelectorAll<HTMLElement>('button')) inner.tabIndex = -1
  }

  function currentPane (): ChromePane | null {
    const active = document.activeElement
    if (active === null || active === document.body) return null
    if (active === address || active.closest('#address-form') !== null) return 'address'
    if (toolbar?.contains(active) === true) return 'toolbar'
    if (tabrow?.contains(active) === true) return 'tabs'
    if (bookmarks?.contains(active) === true) return 'bookmarks'
    return null
  }

  function available (): ChromePane[] {
    const panes: ChromePane[] = ['address']
    if (toolbarItems().some(canFocus)) panes.push('toolbar')
    if (stripItems().some(canFocus)) panes.push('tabs')
    if (bookmarkStop() !== undefined) panes.push('bookmarks')
    return panes
  }

  function entryFor (pane: ChromePane): HTMLElement | undefined {
    switch (pane) {
      case 'address': return address
      case 'toolbar': return syncStops(toolbarItems(), toolbarStop)
      case 'tabs': return stripStopElement(ctxRef?.state() ?? null)
      case 'bookmarks': return bookmarkStop()
    }
  }

  function enter (pane: ChromePane): void {
    const target = entryFor(pane)
    if (target === undefined) return
    target.focus()
    if (target instanceof HTMLInputElement) target.select()
    announce(LABELS[pane])
  }

  /** Hands the keyboard to main, which owns whatever lies outside the chrome. */
  function leave (to: { direction: 1 | -1 } | { to: 'page' }): void {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    void ctxRef?.shell.act('pane.leave', to)
  }

  function step (direction: 1 | -1): void {
    const panes = available()
    const current = currentPane()
    if (current === null) {
      const first = direction === 1 ? panes[0] : panes.at(-1)
      if (first !== undefined) enter(first)
      return
    }
    const next = panes[panes.indexOf(current) + direction]
    if (next === undefined) leave({ direction })
    else enter(next)
  }

  function announceTab (el: HTMLElement): void {
    if (!el.classList.contains('tab')) return
    const tabs = [...(tabrow?.querySelectorAll<HTMLElement>('.tab') ?? [])]
    announce(`Tab ${String(tabs.indexOf(el) + 1)} of ${String(tabs.length)}, ${el.getAttribute('aria-label') ?? ''}`)
  }

  /** Puts the keyboard back on the strip after a rebuild took the focused element away. */
  function restoreStripFocus (state: ShellState): void {
    if (!stripHasFocus || !document.hasFocus()) return
    if (document.activeElement !== null && document.activeElement !== document.body) return
    const target = stripStopElement(state)
    if (target === undefined) return
    target.focus()
  }

  function wireStrip (ctx: ChromeContext, row: HTMLElement): void {
    const { shell } = ctx
    const idOf = (el: HTMLElement): string | undefined => el.classList.contains('tab') ? el.dataset['id'] : undefined
    attachRoving({
      root: row,
      items: () => stripItems().filter(canFocus),
      moved: (el) => { announceTab(el) },
      keys: (event, el) => {
        const id = idOf(el)
        // A button inside the tab (its close button, reached with the pointer) keeps its own Enter and Space.
        if (id === undefined || event.target !== el) return false
        if ((event.key === 'Enter' || event.key === ' ') && !event.shiftKey) {
          shell.activateTab(id)
          return true
        }
        if (event.key === 'Delete' && !event.shiftKey) {
          // The neighbour takes the keyboard when this tab goes, as it would in any list.
          const tabs = stripItems().filter((item) => item.classList.contains('tab'))
          const at = tabs.indexOf(el)
          const next = tabs[at + 1] ?? tabs[at - 1]
          if (next !== undefined) stripStop = stripKey(next)
          shell.closeTab(id)
          return true
        }
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          shell.showTabMenu(id)
          return true
        }
        return false
      }
    })
    row.addEventListener('focusin', (event) => {
      const el = event.target instanceof Element ? event.target.closest<HTMLElement>(STRIP_ITEMS) : null
      stripHasFocus = true
      if (el === null) return
      stripStop = stripKey(el)
      syncStrip(ctx.state())
    })
  }

  function wireToolbar (row: HTMLElement): void {
    attachRoving({ root: row, items: () => toolbarItems().filter(canFocus) })
    row.addEventListener('focusin', (event) => {
      const el = event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null
      if (el === null || el.closest('#address-form') !== null) return
      toolbarStop = el
      syncStops(toolbarItems(), toolbarStop)
    })
  }

  const module: ChromeModule = {
    name: 'panes',
    init: (ctx) => {
      ctxRef = ctx
      toolbar = must(document.querySelector<HTMLElement>('#toolbar'), '#toolbar missing')
      tabrow = must(document.querySelector<HTMLElement>('#tabrow'), '#tabrow missing')
      bookmarks = must(document.querySelector<HTMLElement>('#bookmarks-bar'), '#bookmarks-bar missing')
      address = must(document.querySelector<HTMLInputElement>('#address'), '#address missing')
      live = document.createElement('div')
      live.className = 'sr-only'
      live.setAttribute('aria-live', 'polite')
      live.setAttribute('role', 'status')
      document.body.append(live)
      wireToolbar(toolbar)
      wireStrip(ctx, tabrow)
      document.addEventListener('focusin', (event) => {
        if (!(event.target instanceof Node) || tabrow?.contains(event.target) === true) return
        stripHasFocus = false
      })
      window.addEventListener('blur', () => { stripHasFocus = false })
      // Escape in the toolbar, the strip or the bookmarks bar gives the keyboard back to the page. The address
      // bar has an Escape of its own (it closes the suggestions first).
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
        const pane = currentPane()
        if (pane === null || pane === 'address') return
        event.preventDefault()
        leave({ to: 'page' })
      })
    },
    render: (state) => {
      // Whichever tab is in front becomes the strip's stop when it changes, so F6 lands on it.
      if (state.activeTabId !== shownActive) {
        shownActive = state.activeTabId
        stripStop = state.activeTabId
      }
      syncStrip(state)
      syncStops(toolbarItems(), toolbarStop)
      restoreStripFocus(state)
    },
    event: (payload) => {
      if (typeof payload !== 'object' || payload === null) return
      const event = payload as { type?: unknown, edge?: unknown, direction?: unknown, pane?: unknown }
      if (event.type === 'enter') {
        const panes = available()
        const target = event.edge === 'last' ? panes.at(-1) : panes[0]
        if (target !== undefined) enter(target)
      } else if (event.type === 'step' && (event.direction === 1 || event.direction === -1)) {
        step(event.direction)
      } else if (event.type === 'go' && isPane(event.pane)) {
        enter(event.pane)
      }
    }
  }
  return { module, decorator }
}
