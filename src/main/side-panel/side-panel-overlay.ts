// The panel's page: a view picker, a search field and one list of rows, docked beside the page. What a request
// does is decided here and in ./panel-views.ts; the page only draws rows and asks for things by id.
import { openAddress } from '../shell/bookmarks-bar/open-bookmark.js'
import { contain } from '../shell/contain.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { PANEL_VIEWS, viewById } from './panel-views.js'
import type { PanelRow } from './panel-views.js'
import { asRequest } from './panel-requests.js'
import { panelOf, SIDE_PANEL_OVERLAY, guestEntries } from './side-panel-host.js'

/** Folders the tree opens expanded the first time it is shown. */
export const DEFAULT_OPEN: readonly string[] = ['bar', 'other']
/** Changes that arrive together (a page loading writes several) become one refresh of the list. */
export const REFRESH_MS = 150

export function createSidePanelHandler (win: OverlayWindow): OverlayHandler {
  const { window } = win
  let stopWatching: (() => void) | null = null
  let stopHost: (() => void) | null = null
  let watched = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  function metas (): unknown[] {
    return PANEL_VIEWS.map(({ id, title, icon, searchLabel, things, empty, emptyPrivate, page, remove }) => ({
      id, title, icon, searchLabel, things, page: page?.label ?? null, removable: remove !== undefined,
      empty: win.services.isPrivate && emptyPrivate !== undefined ? emptyPrivate : empty
    }))
  }

  function rowsOf (viewId: string, query: string, open: ReadonlySet<string>): PanelRow[] {
    const view = viewById(viewId)
    return view === undefined ? [] : contain(`side panel ${viewId} rows`, [], () => view.rows(win, query, open))
  }

  function refresh (): void {
    if (timer !== null || watched === '') return
    timer = setTimeout(() => {
      timer = null
      if (watched === '') return
      win.send({ type: 'changed', view: watched })
    }, REFRESH_MS)
  }

  /** Follows the store behind whichever of Orivon's views is showing. */
  function rewatch (): void {
    const host = panelOf(window)
    const id = host?.view() ?? ''
    if (id === watched && stopWatching !== null) return
    stopWatching?.()
    stopWatching = null
    watched = id
    const view = viewById(id)
    if (view?.watch !== undefined) stopWatching = contain('side panel watch', null, () => view.watch?.(win, refresh) ?? null)
  }

  function stop (): void {
    stopWatching?.()
    stopHost?.()
    stopWatching = null
    stopHost = null
    watched = ''
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function open (viewId: string, id: string, how: 'current' | 'background' | 'window'): void {
    const view = viewById(viewId)
    if (view === undefined) return
    if (view.activate !== undefined) { view.activate(win, id); return }
    const url = view.resolve?.(win, id) ?? null
    if (url === null || !openAddress(win, url, how)) return
    view.opened?.(win, id)
    if (how === 'current') panelOf(window)?.focusPage()
  }

  return {
    show: () => {
      stop()
      const host = panelOf(window)
      if (host === undefined) return undefined
      rewatch()
      stopHost = host.onChange(rewatch)
      const view = host.view()
      return {
        views: metas(), guests: guestEntries(), view, guest: host.guestSummary(), side: host.side(), width: host.width(), limits: host.limits(),
        isPrivate: win.services.isPrivate, defaultOpen: DEFAULT_OPEN, rows: rowsOf(view, '', new Set(DEFAULT_OPEN))
      }
    },
    request: (command) => {
      const asked = asRequest(command)
      const host = panelOf(window)
      if (asked === undefined || host === undefined) return undefined
      switch (asked.type) {
        case 'rows': return { view: asked.view, rows: rowsOf(asked.view, asked.query, new Set(asked.open)) }
        case 'open': open(asked.view, asked.id, asked.how); return undefined
        case 'remove': viewById(asked.view)?.remove?.(win, asked.id); return undefined
        case 'view': host.choose(asked.view); return undefined
        case 'page': {
          const page = viewById(asked.view)?.page
          if (page !== undefined) window.tabs.openInternal(page.id)
          return undefined
        }
        case 'resize': host.resize(asked.width); return undefined
        case 'focus-page': host.focusPage(); return undefined
        case 'close': host.close(); return undefined
      }
    },
    moved: () => { panelOf(window)?.moved() },
    closed: (reason) => {
      stop()
      panelOf(window)?.overlayClosed(reason)
    },
    disposed: stop
  }
}

export const sidePanelOverlay: OverlayDef = {
  name: SIDE_PANEL_OVERLAY,
  placement: { kind: 'dock' },
  surface: 'panel',
  focus: 'take',
  layer: 'bar',
  // The panel stays through tab switches, navigations and resizes: only the person (or a crash) closes it.
  closeOn: { blur: false, tabSwitch: false, navigation: false, layout: false },
  keep: 'warm',
  attach: createSidePanelHandler
}
