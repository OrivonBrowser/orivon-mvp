import type { ShellState, TabState } from '../../main/shell/tabs.js'
import { closeIcon, faviconElement } from '../icons.js'
import { isDraggingTab, makeTabDraggable } from '../tab-drag.js'
import type { ChromeContext, ChromeModule, TabDecorator } from './context.js'
import { must } from './context.js'
import { contained, runDecorators } from './contain.js'
import { placeAmongAll } from './tab-groups.js'

function renderFavicon (tab: TabState): HTMLSpanElement {
  const fav = document.createElement('span')
  fav.className = 'fav'
  if (tab.loading) {
    fav.classList.add('loading')
  } else if (tab.isNewTab) {
    // The mark is the .newtab class's own background image (tabstrip.css) -- nothing goes inside it.
    fav.classList.add('newtab')
  } else {
    fav.append(faviconElement(tab.favicon))
  }
  return fav
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
  let renderDeferred = false
  let shownActiveId: string | null = null

  /** Which ends of the scrolling run have more tabs past them, for the edge fade: the scrollbar is hidden, so this
   * is the only sign that tabs lie out of view. */
  function markOverflow (): void {
    const scroller = tabScroll
    if (scroller === undefined) return
    const before = scroller.scrollLeft > 1
    const after = scroller.scrollLeft < scroller.scrollWidth - scroller.clientWidth - 1
    scroller.dataset['fade'] = before && after ? 'both' : before ? 'start' : after ? 'end' : 'none'
  }

  function renderTabs (state: ShellState, ctx: ChromeContext): void {
    if (tabrow === undefined || tabScroll === undefined || newTabBtn === undefined) return
    const row = tabrow
    const scroller = tabScroll
    const { shell } = ctx
    // A tab held by the pointer is not rebuilt under it; the strip is redrawn when it is let go.
    if (isDraggingTab()) {
      renderDeferred = true
      return
    }
    renderDeferred = false
    // Rebuilds the whole strip on every push rather than diffing -- simple, and tab counts are small enough
    // that this never shows up as jank.
    row.querySelectorAll('.tab').forEach((el) => { el.remove() })

    for (const tab of state.tabs) {
      const el = document.createElement('div')
      // #tabrow is a drag region (index.html); without `no-drag` here, every click on a tab is consumed by
      // the OS as a window drag instead of reaching this listener: a draggable area "ignores all pointer
      // events" unless excluded.
      el.className = 'tab no-drag'
      el.classList.toggle('active', tab.id === state.activeTabId)
      el.setAttribute('role', 'tab')
      el.setAttribute('aria-selected', String(tab.id === state.activeTabId))
      el.dataset['id'] = tab.id
      if (tab.splitWith !== null) {
        // Joined tabs are one pill: the pane the person is not in is a shade lighter.
        el.classList.add('joined', state.tabs.findIndex((other) => other.id === tab.splitWith) > state.tabs.findIndex((other) => other.id === tab.id) ? 'joined-first' : 'joined-second')
        el.title = 'Split view'
      }

      const title = document.createElement('span')
      title.className = 'title'
      title.textContent = tab.title.length > 0 ? tab.title : 'New tab'

      const close = document.createElement('button')
      close.className = 'close no-drag'
      close.type = 'button'
      close.setAttribute('aria-label', `Close ${title.textContent}`)
      close.append(closeIcon())
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        shell.closeTab(tab.id)
      })

      el.append(renderFavicon(tab), title, close)
      el.addEventListener('click', () => shell.activateTab(tab.id))
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        shell.showTabMenu(tab.id)
      })
      makeTabDraggable(el, tab.id, {
        // A collapsed group's tabs take no room, so they are not places to drop on.
        tabs: () => [...row.querySelectorAll<HTMLElement>('.tab')].filter((tabEl) => !tabEl.hidden),
        isPinned: (tabEl) => tabEl.classList.contains('pinned'),
        partnerOf: () => tab.splitWith === null ? null : row.querySelector<HTMLElement>(`.tab[data-id="${tab.splitWith}"]`),
        stripHeight: () => row.getBoundingClientRect().height,
        moveTab: (id, index) => { shell.moveTab(id, placeAmongAll(row, [id, tab.splitWith], index)) },
        dragStarted: (id) => { shell.beginTabDrag(id) },
        hover: (id, x, y) => { shell.dragTab(id, x, y) },
        dropTab: (id, x, y, clientX, clientY) => { shell.dropTab(id, x, y, clientX, clientY) },
        // Let go in the strip, the order on screen is already the order main is about to confirm.
        finished: (tornOut) => {
          const latest = ctx.state()
          if ((tornOut || renderDeferred) && latest !== null) renderTabs(latest, ctx)
        },
        dragEnded: () => { shell.endTabDrag() }
      })
      // Middle-click closes a tab. Guarded on mousedown too: Windows arms Blink's middle-click autoscroll on
      // mousedown, before 'auxclick' fires, so preventDefault() there alone is too late on that platform.
      el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault() })
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault()
          shell.closeTab(tab.id)
        }
      })
      runDecorators(decorators, el, tab, state, ctx)
      // Pinned tabs stay put in front; the rest scroll in their own run, so the new-tab and search buttons
      // never scroll away and nothing paints under the window buttons.
      if (tab.pinned) scroller.before(el)
      else scroller.append(el)
    }
    scroller.style.setProperty('--tab-count', String(Math.max(1, scroller.childElementCount)))
    for (const finish of finishers) contained('tab strip finisher', () => { finish(scroller, state, ctx) })
    const active = scroller.querySelector<HTMLElement>('.tab.active')
    if (state.activeTabId !== shownActiveId && active !== null && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    }
    shownActiveId = state.activeTabId
    markOverflow()
  }

  function showDropMark (index: number): void {
    const row = tabrow
    if (row === undefined) return
    dropMark ??= (() => {
      const el = document.createElement('div')
      el.className = 'drop-mark'
      row.append(el)
      return el
    })()
    // An approximate place, not real tab boundaries: the index itself is what must agree with where a drop
    // would actually land (tab-move.ts's `crossWindowTargetFor`), which this only has to point at closely
    // enough to read as "here".
    const tabs = [...row.querySelectorAll<HTMLElement>('.tab')]
    const before = tabs[index]
    const rowLeft = row.getBoundingClientRect().left
    // The row itself never scrolls (only the run of unpinned tabs inside it does), and a tab's viewport rect
    // already accounts for that run's scroll, so the distance from the row's edge is the mark's place.
    const x = before !== undefined
      ? before.getBoundingClientRect().left - rowLeft
      : (tabs.at(-1)?.getBoundingClientRect().right ?? rowLeft) - rowLeft
    dropMark.style.left = `${String(x)}px`
    dropMark.hidden = false
  }

  return {
    name: 'tab-strip',
    init: ({ shell }) => {
      tabrow = must(document.querySelector<HTMLDivElement>('#tabrow'), '#tabrow missing')
      tabScroll = must(document.querySelector<HTMLDivElement>('#tab-scroll'), '#tab-scroll missing')
      tabScroll.addEventListener('scroll', markOverflow, { passive: true })
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
    },
    render: renderTabs,
    event: (payload) => {
      const event = payload as { type?: string, index?: number }
      if (event.type === 'dragMark' && typeof event.index === 'number') showDropMark(event.index)
      else if (event.type === 'dragMarkClear' && dropMark !== null) dropMark.hidden = true
    }
  }
}
