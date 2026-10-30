// What tells a page arriving from a click away, and whether a popup opened for it is still about what arrived. Tied to Electron: it listens to a tab's webContents.
import type { WebContents } from 'electron'
import type { FirstPage } from '../shell/window-state.js'

/** The events of a tab's page that the hold listens to; a test hands it an emitter with these. */
export type ArrivingPage = Pick<WebContents, 'on' | 'removeListener'>

/** The input a person makes to press in a page, by mouse or by touch: a move or a key is no press. */
const PRESSES: ReadonlySet<string> = new Set(['mouseDown', 'pointerDown', 'touchStart', 'gestureTapDown', 'gestureTap'])

export interface ArrivalHold {
  /** The page took the keyboard from the popup since the popup last held it and nothing was pressed in the page first: its first page committing, not the person clicking away. */
  arrivedWithKeyboard: () => boolean
  /** The popup holds the keyboard now. A page that took it before, while the popup was still loading, took it from the chrome and is no arrival to the popup. */
  popupHoldsKeyboard: () => void
  /** Stops listening. Called once the keyboard has been handed back, when the page has finished loading or is gone, and when the popup closes. */
  end: () => void
}

/**
 * Begins watching a tab whose first page has not committed, for a popup that was opened while it loaded. A page that commits
 * takes the keyboard in that moment and the popup then blurs, which closes it as a click away does; a press in the page first is
 * a click away, and so is anything after the page has loaded. `onEnd` runs once, whichever way the hold ends.
 */
export function watchArrival (page: ArrivingPage, onEnd: () => void): ArrivalHold {
  let tookKeyboard = false
  let pressed = false
  let ended = false
  const onFocus = (): void => { tookKeyboard = true }
  const onInput = (_event: unknown, input: { readonly type: string }): void => { if (PRESSES.has(input.type)) pressed = true }
  const end = (): void => {
    if (ended) return
    ended = true
    page.removeListener('focus', onFocus)
    page.removeListener('input-event', onInput)
    page.removeListener('did-stop-loading', end)
    page.removeListener('destroyed', end)
    onEnd()
  }
  page.on('focus', onFocus)
  page.on('input-event', onInput)
  page.on('did-stop-loading', end)
  page.on('destroyed', end)
  return { arrivedWithKeyboard: () => tookKeyboard && !pressed, popupHoldsKeyboard: () => { tookKeyboard = false }, end }
}

/**
 * Whether a popup opened for the tab `open.tab`, or for the website `open.origin` when that is null, is still about `arrived`, the
 * first page a tab committed (null for any other change of the tab in front or its origin). A list opened while a tab's page was
 * loading is right when the page comes; any other change leaves it stale. A popup of a tab drawn for a website (`open.shown`, ''
 * for none) is right only when that website arrives: the rows, the storage notice and the "Always" switch are its.
 */
export function popupIsAbout (open: { readonly tab: string | null, readonly origin: string, readonly shown?: string }, arrived: FirstPage | null): boolean {
  if (arrived === null) return false
  if (open.tab === null) return arrived.origin !== null && open.origin === arrived.origin
  return open.tab === arrived.tabId && (open.shown === undefined || open.shown === '' || open.shown === arrived.origin)
}
