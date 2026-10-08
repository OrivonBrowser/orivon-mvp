// Follows one tab's web contents and covers the tab with its protocol's loading screen from a moment after a
// navigation to one of that protocol's addresses starts until the page's document is ready. The cover belongs to
// that load only: any other navigation, a failure or a stop takes it away.
import type { WebContents } from 'electron'
import type { LoadingScreen } from '../../protocols/protocol.js'
import type { requestSlot } from '../overlays/tab-slots.js'
import type { ShellWindow } from '../shell/window-registry.js'

export const LOADING_SCREEN_OVERLAY = 'loading-screen'

/** A load that finishes sooner than this (a cached site, a reload) never flashes the screen. */
export const SHOW_AFTER_MS = 300

/** A navigation cancelled by a newer one, by the person, or because it became a download. */
const ERR_ABORTED = -3

export interface LoadingScreenDeps {
  readonly findTab: (contents: WebContents) => { window: ShellWindow, tabId: string } | null
  readonly ask: typeof requestSlot
  /** The screen to show while this address loads, or undefined for an address that has none. */
  readonly screenFor: (url: string) => LoadingScreen | undefined
  /** Builds the overlay's view ahead of its show, so the screen appears with its page ready. */
  readonly prewarm: (window: ShellWindow) => void
  /** A first visit to an app owns this tab's cover (`../app-setup/`): the protocol's own screen would replace its words. */
  readonly claimed?: (contents: WebContents) => boolean
}

interface Cover {
  handle: { cancel: () => void } | undefined
  ended: boolean
}

const watched = new WeakSet<WebContents>()

export function watchLoadingScreen (contents: WebContents, deps: LoadingScreenDeps): void {
  if (watched.has(contents)) return
  watched.add(contents)
  let timer: ReturnType<typeof setTimeout> | undefined
  let cover: Cover | undefined
  // The previous page's own `dom-ready` can land after the new navigation started: only a commit of the new one lets it count.
  let committed = false

  const withdraw = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const old = cover
    cover = undefined
    old?.handle?.cancel()
  }

  const show = (url: string): void => {
    const found = deps.findTab(contents)
    if (found === null || deps.claimed?.(contents) === true) return
    const mine: Cover = { handle: undefined, ended: false }
    mine.handle = deps.ask({
      window: found.window,
      tabId: found.tabId,
      slot: 'cover',
      overlay: LOADING_SCREEN_OVERLAY,
      payload: { url },
      closed: () => {
        mine.ended = true
        if (cover === mine) cover = undefined
      }
    })
    if (!mine.ended) cover = mine
  }

  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    if (deps.screenFor(details.url) === undefined) { withdraw(); return }
    const found = deps.findTab(contents)
    if (found === null) return
    committed = false
    deps.prewarm(found.window)
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    // A screen already up changes its address in place; a new one waits, so a fast load never shows it.
    if (cover !== undefined) { show(details.url); return }
    timer = setTimeout(() => {
      timer = undefined
      show(details.url)
    }, SHOW_AFTER_MS)
  })
  contents.on('did-redirect-navigation', (details) => {
    if (details.isMainFrame && deps.screenFor(details.url) === undefined) withdraw()
  })
  contents.on('did-navigate', () => { committed = true })
  contents.on('dom-ready', () => { if (committed) withdraw() })
  contents.on('did-fail-load', (_event, code, _name, _url, isMainFrame) => {
    if (isMainFrame && code !== ERR_ABORTED) withdraw()
  })
  contents.on('did-stop-loading', withdraw)
  contents.on('render-process-gone', withdraw)
  contents.on('destroyed', withdraw)
}
