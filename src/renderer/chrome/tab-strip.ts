import type { ShellState, TabState } from '../../main/shell/tabs.js'
import { closeIcon, faviconElement } from '../icons.js'
import { makeStripDraggable } from '../strip-drag.js'
import { isDraggingTab, makeTabDraggable } from '../tab-drag.js'
import type { ChromeContext, ChromeModule, TabDecorator } from './context.js'
import { must } from './context.js'
import { runDecorators } from './contain.js'

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

/** The tab strip, the new-tab button, the empty tail after it, and the insertion line shown while a tab
 * dragged from another window is over this strip. */
export function createTabStrip (decorators: readonly TabDecorator[]): ChromeModule {
  let tabrow: HTMLDivElement | undefined
  let newTabBtn: HTMLButtonElement | undefined
  let dropMark: HTMLDivElement | null = null
  let renderDeferred = false

  function renderTabs (state: ShellState, ctx: ChromeContext): void {
    if (tabrow === undefined || newTabBtn === undefined) return
    const row = tabrow
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
      title.textContent = tab.title.length > 0 ? tab.title : 'New Tab'

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
        tabs: () => [...row.querySelectorAll<HTMLElement>('.tab')],
        partnerOf: () => tab.splitWith === null ? null : row.querySelector<HTMLElement>(`.tab[data-id="${tab.splitWith}"]`),
        stripHeight: () => row.getBoundingClientRect().height,
        moveTab: (id, index) => { shell.moveTab(id, index) },
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
      // Tabs render before the ever-present #new-tab button, matching its fixed position at the end of the strip.
      newTabBtn.before(el)
    }
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
    // #tabrow scrolls horizontally once there are more tabs than fit: a tab's own viewport rect already
    // accounts for that scroll, so the mark needs `scrollLeft` added on top of the viewport-relative distance
    // to land in the row's own scrolled coordinate space.
    const x = (before !== undefined
      ? before.getBoundingClientRect().left - rowLeft
      : (tabs.at(-1)?.getBoundingClientRect().right ?? rowLeft) - rowLeft) + row.scrollLeft
    dropMark.style.left = `${String(x)}px`
    dropMark.hidden = false
  }

  return {
    name: 'tab-strip',
    init: ({ shell }) => {
      tabrow = must(document.querySelector<HTMLDivElement>('#tabrow'), '#tabrow missing')
      newTabBtn = must(document.querySelector<HTMLButtonElement>('#new-tab'), '#new-tab missing')
      const stripTail = must(document.querySelector<HTMLDivElement>('#tab-strip-tail'), '#tab-strip-tail missing')
      newTabBtn.addEventListener('click', () => shell.newTab())
      // The empty strip past the new-tab button: only wired up here in the manual drag mode (drag-mode.ts
      // decides, main-side) -- in the native mode the tail is plain OS-level drag content and none of this runs.
      if (shell.dragMode === 'manual') {
        makeStripDraggable(stripTail, {
          newTab: () => { shell.newTab() },
          toggleMaximize: () => { shell.toggleMaximize() },
          moveStart: (x, y) => { shell.windowMoveStart(x, y) },
          moveTo: (x, y) => { shell.windowMoveTo(x, y) },
          moveEnd: (x, y) => { shell.windowMoveEnd(x, y) },
          moveCancel: () => { shell.windowMoveCancel() }
        })
      }
    },
    render: renderTabs,
    event: (payload) => {
      const event = payload as { type?: string, index?: number }
      if (event.type === 'dragMark' && typeof event.index === 'number') showDropMark(event.index)
      else if (event.type === 'dragMarkClear' && dropMark !== null) dropMark.hidden = true
    }
  }
}
