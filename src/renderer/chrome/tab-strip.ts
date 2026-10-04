import type { ShellState, TabState } from '../../main/shell/tabs.js'
import { closeIcon, faviconElement } from '../icons.js'
import { isDraggingTab, makeTabDraggable } from '../tab-drag.js'
import { createNativeTabDrag } from '../native-tab-drag.js'
import type { ChromeContext, ChromeModule, TabDecorator } from './context.js'
import { must } from './context.js'
import { contained, runDecorators } from './contain.js'
import { placeAmongAll } from './tab-groups.js'

/** What one line of a wheel that counts in lines scrolls the strip by. */
const WHEEL_LINE_PX = 40

/** One tab's element, its three parts, and what was last drawn into them. */
interface TabEntry {
  el: HTMLElement
  fav: HTMLSpanElement
  title: HTMLSpanElement
  close: HTMLButtonElement
  titleText: string
  /** What the icon shows now: loading, the new-tab mark, the globe, a crash, or one favicon (`icon:` and its data URL). */
  iconKey: string
  /** What the tab's look was last computed from (`signatureOf`). */
  signature: string
}

/** What a feature does to the strip's tab run once every tab is in it. */
export type StripFinisher = (scroller: HTMLElement, state: ShellState, ctx: ChromeContext) => void

/** The tab strip, the new-tab button, the empty tail after it, and the insertion line shown while a tab
 * dragged from another window is over this strip. */
export function createTabStrip (decorators: readonly TabDecorator[], finishers: readonly StripFinisher[] = []): ChromeModule {
  let tabrow: HTMLDivElement | undefined
  let tabScroll: HTMLDivElement | undefined
  let newTabBtn: HTMLButtonElement | undefined
  let dropMark: HTMLDivElement | null = null
  /** Set when tabs are dragged by the browser's own drag and drop (native-tab-drag.ts), else they drag with the pointer (tab-drag.ts). */
  let native: ReturnType<typeof createNativeTabDrag> | null = null
  let renderDeferred = false
  let shownActiveId: string | null = null
  /** One element per tab, kept across pushes: a push patches what differs instead of building the strip again. */
  const entries = new Map<string, TabEntry>()
  /** The tabs of the newest state, by id: handlers on a long-lived element read the tab here, never from the state they were built in. */
  const latest = new Map<string, TabState>()
  /** The unpinned tabs counted in `--tab-count` the last time it was written. */
  let shownCount = -1
  let measured: { nodes: HTMLElement[], hidden: boolean[], pinned: number } = { nodes: [], hidden: [], pinned: 0 }

  /** Which ends of the scrolling run have more tabs past them, for the edge fade: the scrollbar is hidden, so this
   * is the only sign that tabs lie out of view. */
  function markOverflow (): void {
    const scroller = tabScroll
    if (scroller === undefined) return
    const before = scroller.scrollLeft > 1
    const after = scroller.scrollLeft < scroller.scrollWidth - scroller.clientWidth - 1
    scroller.dataset['fade'] = before && after ? 'both' : before ? 'start' : after ? 'end' : 'none'
  }

  /** The strip scrolls sideways and has no scrollbar, so an ordinary mouse wheel, which only turns up and down,
   * scrolls it along. A sideways wheel or touchpad swipe, and a wheel with the strip already at that end, are left to
   * the page's own handling. */
  function wheelAlongStrip (event: WheelEvent): void {
    const scroller = tabScroll
    if (scroller === undefined || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    const room = scroller.scrollWidth - scroller.clientWidth
    if (room <= 0) return
    const step = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * WHEEL_LINE_PX
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * scroller.clientWidth : event.deltaY
    const next = Math.min(Math.max(scroller.scrollLeft + step, 0), room)
    if (next === scroller.scrollLeft) return
    event.preventDefault()
    scroller.scrollLeft = next
  }

  /** The tabs of the row that take room: a collapsed group's are hidden. */
  function shownTabs (row: ParentNode): HTMLElement[] {
    return [...row.querySelectorAll<HTMLElement>('.tab')].filter((tabEl) => !tabEl.hidden)
  }

  /** The tab element after `el` among `el`'s siblings, skipping what is not a tab (a group chip). */
  function followingTab (el: Element): Element | null {
    for (let next = el.nextElementSibling; next !== null; next = next.nextElementSibling) {
      if (next.classList.contains('tab')) return next
    }
    return null
  }

  /** Puts the tabs `ids` in this order inside `parent`, the last one before `end`, and moves only a tab that does not
   * already sit right before its successor. */
  function arrange (parent: HTMLElement, ids: readonly string[], end: Element | null): void {
    let next: Element | null = null
    for (let at = ids.length - 1; at >= 0; at--) {
      const el = entries.get(ids[at] ?? '')?.el
      if (el === undefined) continue
      if (el.parentElement !== parent || followingTab(el) !== next) parent.insertBefore(el, next ?? end)
      next = el
    }
  }

  function createEntry (id: string, row: HTMLElement, ctx: ChromeContext): TabEntry {
    const { shell } = ctx
    const el = document.createElement('div')
    el.setAttribute('role', 'tab')
    el.dataset['id'] = id
    const fav = document.createElement('span')
    fav.className = 'fav'
    const title = document.createElement('span')
    title.className = 'title'
    const close = document.createElement('button')
    close.className = 'close no-drag'
    close.type = 'button'
    close.append(closeIcon())
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      shell.closeTab(id)
    })
    el.append(fav, title, close)
    el.addEventListener('click', () => shell.activateTab(id))
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      shell.showTabMenu(id)
    })
    // Every handler below reads the tab from `latest`: the element outlives the state it was made from.
    const partnerId = (): string | null => latest.get(id)?.splitWith ?? null
    if (native !== null) native.attach(el, id)
    else makeTabDraggable(el, id, {
      // A collapsed group's tabs take no room, so they are not places to drop on.
      tabs: () => shownTabs(row),
      isPinned: (tabEl) => tabEl.classList.contains('pinned'),
      partnerOf: () => {
        const partner = partnerId()
        return partner === null ? null : entries.get(partner)?.el ?? null
      },
      stripHeight: () => row.getBoundingClientRect().height,
      moveTab: (moved, index) => { shell.moveTab(moved, placeAmongAll(row, [moved, partnerId()], index)) },
      dragStarted: (started) => { shell.beginTabDrag(started) },
      hover: (hovered, x, y) => { shell.dragTab(hovered, x, y) },
      dropTab: (dropped, x, y, clientX, clientY) => { shell.dropTab(dropped, x, y, clientX, clientY) },
      // Let go in the strip, the order on screen is already the order main is about to confirm.
      finished: (tornOut) => {
        const newest = ctx.state()
        if ((tornOut || renderDeferred) && newest !== null) renderTabs(newest, ctx)
      },
      dragEnded: () => { shell.endTabDrag() }
    })
    // Middle-click closes a tab. Guarded on mousedown too: Windows arms Blink's middle-click autoscroll on
    // mousedown, before 'auxclick' fires, so preventDefault() there alone is too late on that platform.
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault() })
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        shell.closeTab(id)
      }
    })
    return { el, fav, title, close, titleText: '', iconKey: '', signature: '' }
  }

  /** Redraws the icon only when what it shows changed, so an unchanged icon keeps its `<img>`. */
  function syncFavicon (entry: TabEntry, tab: TabState): void {
    const key = tab.crashed !== null ? 'crashed' : tab.loading ? 'loading' : tab.isNewTab ? 'newtab' : tab.favicon === null ? 'globe' : `icon:${tab.favicon}`
    if (key === entry.iconKey) return
    entry.iconKey = key
    const { fav } = entry
    fav.className = 'fav'
    if (tab.loading) {
      fav.classList.add('loading')
      fav.replaceChildren()
    } else if (tab.isNewTab) {
      // The mark is the .newtab class's own background image (tabstrip.css) -- nothing goes inside it.
      fav.classList.add('newtab')
      fav.replaceChildren()
    } else {
      fav.replaceChildren(faviconElement(tab.favicon))
    }
  }

  /** What decides how a tab looks besides its icon: the tab's own fields and its place among the others. */
  function signatureOf (tab: TabState, index: number, state: ShellState): string {
    const fields: Partial<TabState> = { ...tab }
    delete fields.favicon
    const partner = tab.splitWith === null ? 0 : state.tabs.findIndex((other) => other.id === tab.splitWith) > index ? 1 : 2
    const group = tab.group === undefined || tab.group === null ? null : state.groups?.find((candidate) => candidate.id === tab.group)
    return JSON.stringify([fields, tab.id === state.activeTabId, partner, state.tabs[index + 1]?.pinned === false, group])
  }

  /** Puts everything the tab's look comes from back to its starting point, then lets the decorators draw theirs again. */
  function restyle (entry: TabEntry, tab: TabState, index: number, state: ShellState, ctx: ChromeContext): void {
    const { el } = entry
    const isActive = tab.id === state.activeTabId
    let classes = 'tab no-drag'
    if (isActive) classes += ' active'
    el.removeAttribute('title')
    el.removeAttribute('aria-label')
    delete el.dataset['group']
    delete el.dataset['color']
    el.hidden = false
    el.setAttribute('aria-selected', String(isActive))
    if (tab.splitWith !== null) {
      // Joined tabs are one pill: the pane the person is not in is a shade lighter.
      classes += state.tabs.findIndex((other) => other.id === tab.splitWith) > index ? ' joined joined-first' : ' joined joined-second'
      el.title = 'Split view'
    }
    el.className = classes
    const titleText = tab.title.length > 0 ? tab.title : 'New tab'
    if (titleText !== entry.titleText) {
      entry.titleText = titleText
      entry.title.textContent = titleText
      entry.close.setAttribute('aria-label', `Close ${titleText}`)
    }
    // What a decorator added besides the three parts the strip owns goes; a pinned tab's missing close button comes back.
    for (const child of [...el.children]) {
      if (child !== entry.fav && child !== entry.title && child !== entry.close) child.remove()
    }
    if (entry.close.parentElement !== el) el.append(entry.close)
    syncFavicon(entry, tab)
    runDecorators(decorators, el, tab, state, ctx)
  }

  function renderTabs (state: ShellState, ctx: ChromeContext): void {
    if (tabrow === undefined || tabScroll === undefined || newTabBtn === undefined) return
    const row = tabrow
    const scroller = tabScroll
    latest.clear()
    for (const tab of state.tabs) latest.set(tab.id, tab)
    // A tab held by the pointer is not touched under it; the strip is redrawn when it is let go.
    if (isDraggingTab()) {
      renderDeferred = true
      return
    }
    renderDeferred = false
    for (const [id, entry] of entries) {
      if (latest.has(id)) continue
      entry.el.remove()
      entries.delete(id)
    }
    const pinnedIds: string[] = []
    const scrollIds: string[] = []
    state.tabs.forEach((tab, index) => {
      let entry = entries.get(tab.id)
      if (entry === undefined) {
        entry = createEntry(tab.id, row, ctx)
        entries.set(tab.id, entry)
      }
      const signature = signatureOf(tab, index, state)
      if (signature !== entry.signature) {
        entry.signature = signature
        restyle(entry, tab, index, state, ctx)
      } else {
        syncFavicon(entry, tab)
      }
      if (tab.pinned) pinnedIds.push(tab.id)
      else scrollIds.push(tab.id)
    })
    // Pinned tabs stay put in front; the rest scroll in their own run, so the new-tab and search buttons
    // never scroll away and nothing paints under the window buttons.
    arrange(row, pinnedIds, scroller)
    arrange(scroller, scrollIds, null)
    if (scrollIds.length !== shownCount) {
      shownCount = scrollIds.length
      scroller.style.setProperty('--tab-count', String(Math.max(1, shownCount)))
    }
    for (const finish of finishers) contained('tab strip finisher', () => { finish(scroller, state, ctx) })
    const activeChanged = state.activeTabId !== shownActiveId
    const active = activeChanged && state.activeTabId !== null ? entries.get(state.activeTabId)?.el : undefined
    if (active !== undefined && active.parentElement === scroller && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    }
    shownActiveId = state.activeTabId
    if (activeChanged || layoutChanged(row, scroller)) markOverflow()
  }

  /** Whether what the scroller holds, or the room the pinned tabs take, differs from the last time it was measured. */
  function layoutChanged (row: HTMLElement, scroller: HTMLElement): boolean {
    const nodes = [...scroller.children] as HTMLElement[]
    const hidden = nodes.map((node) => Boolean(node.hidden))
    const pinned = [...row.children].filter((node) => node.classList.contains('tab')).length
    const same = pinned === measured.pinned && nodes.length === measured.nodes.length && nodes.every((node, at) => node === measured.nodes[at] && hidden[at] === measured.hidden[at])
    measured = { nodes, hidden, pinned }
    return !same
  }

  /** Draws the line before the tab at `index` among the tabs but the `held` ones (a tab being dragged in this strip). */
  function showDropMark (index: number, held: readonly string[] = []): void {
    const row = tabrow
    if (row === undefined) return
    dropMark ??= (() => {
      const el = document.createElement('div')
      el.className = 'drop-mark'
      row.append(el)
      return el
    })()
    // The index is a place in the state's tab order, which is the order of the `.tab` elements; a tab hidden in
    // a collapsed group takes no room, so the line goes before the next tab shown (as `placeAmongAll` reads
    // it), or after the last one.
    const tabs = [...row.querySelectorAll<HTMLElement>('.tab')].filter((tab) => !held.includes(tab.dataset['id'] ?? ''))
    const before = tabs.slice(Math.max(0, index)).find((tab) => !tab.hidden)
    const rowLeft = row.getBoundingClientRect().left
    // The row itself never scrolls (only the run of unpinned tabs inside it does), and a tab's viewport rect
    // already accounts for that run's scroll, so the distance from the row's edge is the mark's place.
    const x = before !== undefined
      ? before.getBoundingClientRect().left - rowLeft
      : (tabs.filter((tab) => !tab.hidden).at(-1)?.getBoundingClientRect().right ?? rowLeft) - rowLeft
    dropMark.style.left = `${String(x)}px`
    dropMark.hidden = false
  }

  return {
    name: 'tab-strip',
    init: (ctx) => {
      const { shell } = ctx
      tabrow = must(document.querySelector<HTMLDivElement>('#tabrow'), '#tabrow missing')
      tabScroll = must(document.querySelector<HTMLDivElement>('#tab-scroll'), '#tab-scroll missing')
      tabScroll.addEventListener('scroll', markOverflow, { passive: true })
      tabScroll.addEventListener('wheel', wheelAlongStrip, { passive: false })
      // A narrower window must not leave the tab in front out of view.
      const scroller = tabScroll
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => {
          scroller.querySelector<HTMLElement>('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
          markOverflow()
        }).observe(scroller)
      }
      newTabBtn = must(document.querySelector<HTMLButtonElement>('#new-tab'), '#new-tab missing')
      newTabBtn.addEventListener('click', () => shell.newTab())
      const row = tabrow
      if (typeof shell.nativeTabDragType === 'string') {
        native = createNativeTabDrag(shell.nativeTabDragType, shell, {
          tabs: () => shownTabs(row),
          isPinned: (tabEl) => tabEl.classList.contains('pinned'),
          partnerOf: (tabEl) => {
            const partner = latest.get(tabEl.dataset['id'] ?? '')?.splitWith ?? null
            return partner === null ? null : entries.get(partner)?.el ?? null
          },
          stateIndex: (held, target) => placeAmongAll(row, held, target),
          showMark: (index, held) => {
            if (index === null) {
              if (dropMark !== null) dropMark.hidden = true
            } else {
              showDropMark(index, held)
            }
          },
          stripBottom: () => row.getBoundingClientRect().bottom,
          toolbarBottom: () => document.querySelector('#toolbar')?.getBoundingClientRect().bottom ?? row.getBoundingClientRect().bottom,
          finished: () => {
            const newest = ctx.state()
            if (renderDeferred && newest !== null) renderTabs(newest, ctx)
          }
        })
      }
    },
    render: renderTabs,
    event: (payload) => {
      const event = payload as { type?: string, index?: number, on?: boolean, pinned?: boolean }
      if (event.type === 'dragMark' && typeof event.index === 'number') showDropMark(event.index)
      else if (event.type === 'dragMarkClear' && dropMark !== null) dropMark.hidden = true
      else if (event.type === 'nativeTabDrag') native?.setTarget(event.on === true, event.pinned === true)
    }
  }
}
