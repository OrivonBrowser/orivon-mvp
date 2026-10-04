import type { BarItem } from '../../main/browsing/bookmark-types.js'
import { chevronRightIcon, folderIcon } from '../pages/shared/icons.js'
import { h } from '../pages/shared/dom.js'
import { faviconElement } from '../icons.js'
import { isDraggingBarItem, makeBarDraggable } from './bar-drag.js'
import { nextStop, parseBarItems, visibleCount } from './bar-overflow.js'
import type { BarKey } from './bar-overflow.js'
import type { ChromeContext, ChromeModule } from './context.js'
import { must } from './context.js'

/** The gap between items and the width of the "More bookmarks" button: styles/bookmarks.css sets the same two. */
const GAP_PX = 4
const MORE_PX = 24
const EMPTY_TEXT = 'Bookmark a page with the star to see it here.'

/** The bookmarks row under the toolbar: the bar's items, a menu for each folder, an overflow button for what does
 * not fit, a right-click menu and drag to reorder. Main sends the items when they change (`bookmarks-bar`). */
export function createBookmarksBar (): ChromeModule {
  let bar: HTMLElement | undefined
  let list: HTMLElement | undefined
  let more: HTMLButtonElement | undefined
  let mark: HTMLElement | undefined
  let ctxRef: ChromeContext | undefined
  let items: BarItem[] = []
  let received = false
  /** Items that arrived while one was held, drawn when it is let go. */
  let waiting: BarItem[] | null = null
  let shown = 0

  const elements = (): HTMLButtonElement[] => Array.from(list?.querySelectorAll<HTMLButtonElement>('.bmitem') ?? [])
  const visible = (): HTMLButtonElement[] => elements().filter((el) => !el.hidden)
  const stops = (): HTMLButtonElement[] => more !== undefined && !more.hidden ? [...visible(), more] : visible()
  const act = (name: string, payload?: unknown): void => { void ctxRef?.shell.act(name, payload) }

  function roving (current: Element | null): void {
    const all = stops()
    const target = all.find((el) => el === current) ?? all[0]
    for (const el of [...elements(), ...(more === undefined ? [] : [more])]) el.tabIndex = el === target ? 0 : -1
  }

  /** Hides the items that do not fit and shows the overflow button when any are hidden. */
  function layout (): void {
    if (list === undefined || more === undefined) return
    const all = elements()
    for (const el of all) el.hidden = false
    more.hidden = true
    // Fractional widths, as painted: the integer offsetWidth rounds each item and can let the last one overhang.
    const available = list.getBoundingClientRect().width
    if (available > 0) {
      const count = visibleCount(all.map((el) => el.getBoundingClientRect().width), available, GAP_PX, MORE_PX)
      all.forEach((el, index) => { el.hidden = index >= count })
      more.hidden = count >= all.length
    }
    roving(document.activeElement)
  }

  function itemElement (item: BarItem): HTMLButtonElement {
    const label = item.title.length > 0 ? item.title : (item.url ?? '')
    const el = h('button', { type: 'button', className: item.title.length > 0 ? 'bmitem' : 'bmitem icon-only', tabIndex: -1 },
      item.kind === 'folder' ? folderIcon() : faviconElement(item.favicon ?? null),
      item.title.length > 0 && h('span', { className: 'bmtitle' }, item.title))
    el.dataset['id'] = item.id
    el.dataset['kind'] = item.kind
    el.title = item.kind === 'url' ? (item.url ?? label) : label
    el.setAttribute('aria-label', label)
    if (item.kind === 'folder') el.setAttribute('aria-haspopup', 'menu')
    if (mark !== undefined) {
      makeBarDraggable(el, {
        items: visible,
        mark: () => must(mark, 'bookmarks drop mark missing'),
        idOf: (node) => node.dataset['id'] ?? '',
        isFolder: (node) => node.dataset['kind'] === 'folder',
        reorder: (id, index) => { act('bookmarks.move', { id, parent: 'bar', index }) },
        fileInto: (id, folder) => { act('bookmarks.move', { id, parent: folder }) }
      })
    }
    return el
  }

  function draw (next: BarItem[]): void {
    if (list === undefined || more === undefined) return
    if (isDraggingBarItem()) { waiting = next; return }
    const hadFocus = list.contains(document.activeElement)
    const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['id'] : undefined
    items = next
    list.replaceChildren(
      ...(items.length === 0 ? [h('span', { className: 'bmempty' }, EMPTY_TEXT)] : items.map(itemElement)),
      more
    )
    layout()
    if (hadFocus) (elements().find((el) => el.dataset['id'] === focusedId && !el.hidden) ?? visible()[0])?.focus()
  }

  function setItems (next: BarItem[]): void {
    received = true
    draw(next)
  }

  function openFolder (el: HTMLElement, extra: { from?: number } = {}): void {
    if (ctxRef === undefined) return
    const id = el.dataset['id'] ?? 'bar'
    act('bookmarks.folder', { id, anchor: ctxRef.anchorFor(el), ...extra })
  }

  function openItem (el: HTMLElement, how: 'current' | 'background' | 'window'): void {
    act('bookmarks.open', { id: el.dataset['id'], disposition: how })
  }

  function menuAt (el: HTMLElement | null, x: number, y: number): void {
    act('bookmarks.menu', { id: el?.dataset['id'] ?? null, x, y, ...(el === null || ctxRef === undefined ? {} : { anchor: ctxRef.anchorFor(el) }) })
  }

  function onClick (event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.bmmore') !== null && target !== null) {
      if (more !== undefined) act('bookmarks.folder', { id: 'bar', from: visible().length, anchor: ctxRef?.anchorFor(more) })
      return
    }
    const el = target?.closest<HTMLElement>('.bmitem') ?? null
    if (el === null) return
    if (el.dataset['kind'] === 'folder') openFolder(el)
    else openItem(el, event.shiftKey ? 'window' : event.ctrlKey || event.metaKey ? 'background' : 'current')
  }

  function onKeydown (event: KeyboardEvent): void {
    const all = stops()
    const at = all.findIndex((el) => el === document.activeElement)
    if (at < 0) return
    const current = all[at] as HTMLElement
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const target = all[nextStop(all.length, at, event.key as BarKey)]
      roving(target ?? null)
      target?.focus()
    } else if (event.key === 'ArrowDown' && (current.dataset['kind'] === 'folder' || current === more)) {
      event.preventDefault()
      if (current === more) act('bookmarks.folder', { id: 'bar', from: visible().length, anchor: ctxRef?.anchorFor(more as HTMLElement) })
      else openFolder(current)
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const box = current.getBoundingClientRect()
      menuAt(current === more ? null : current, box.left, box.bottom)
    }
  }

  return {
    name: 'bookmarks-bar',
    init: (ctx) => {
      ctxRef = ctx
      bar = must(document.querySelector<HTMLElement>('#bookmarks-bar'), '#bookmarks-bar missing')
      list = must(document.querySelector<HTMLElement>('#bookmarks-list'), '#bookmarks-list missing')
      mark = h('div', { className: 'bmdropmark', hidden: true, ariaHidden: 'true' })
      bar.append(mark)
      more = h('button', { type: 'button', className: 'bmmore', title: 'More bookmarks', hidden: true, tabIndex: -1 }, chevronRightIcon())
      more.setAttribute('aria-label', 'More bookmarks')
      more.setAttribute('aria-haspopup', 'menu')
      bar.addEventListener('click', onClick)
      // A folder and the chevron open a menu a press can close: main judges their click by this press (press-stamps.ts).
      bar.addEventListener('pointerdown', (event) => {
        const target = event.target instanceof Element ? event.target : null
        const opensMenu = target?.closest('.bmmore') !== null || target?.closest<HTMLElement>('.bmitem')?.dataset['kind'] === 'folder'
        if (event.button === 0 && target !== null && opensMenu) ctxRef?.shell.press('bookmark-folder')
      })
      bar.addEventListener('keydown', onKeydown)
      bar.addEventListener('focusin', () => { roving(document.activeElement) })
      // A middle press would start Chromium's autoscroll before the release that opens the tab.
      bar.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
      bar.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return
        const el = event.target instanceof Element ? event.target.closest<HTMLElement>('.bmitem') : null
        if (el !== null && el.dataset['kind'] === 'url') { event.preventDefault(); openItem(el, 'background') }
      })
      bar.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        const el = event.target instanceof Element ? event.target.closest<HTMLElement>('.bmitem') : null
        menuAt(el, event.clientX, event.clientY)
      })
      new ResizeObserver(() => { if (!isDraggingBarItem()) layout() }).observe(list)
      window.addEventListener('pointerup', () => {
        // A drag just ended: what main said meanwhile is drawn now.
        setTimeout(() => { if (waiting !== null && !isDraggingBarItem()) { const next = waiting; waiting = null; draw(next) } }, 0)
      })
      draw([])
      void ctx.shell.act('bookmarks.bar').then((reply) => {
        const first = parseBarItems(reply)
        if (!received && first !== null) draw(first)
      })
    },
    render: (state) => {
      // Drives style.css's height override and bookmarks.css's hide rule. main sizes this whole view from the
      // same fact (window-state.ts's chrome height), so the row and the space reserved for it appear together.
      document.documentElement.dataset['bookmarks'] = state.bookmarksBar ? 'some' : 'none'
      const now = state.bookmarksBar ? 1 : 0
      if (now !== shown) { shown = now; layout() }
    },
    event: (payload) => {
      const next = parseBarItems(payload)
      if (next !== null) setItems(next)
    }
  }
}
