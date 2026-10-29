// What tells a page arriving from a click away. Tied to Electron: it listens to a tab's webContents.
import type { WebContents } from 'electron'

/** The events of a tab's page that the hold listens to; a test hands it an emitter with these. */
export type ArrivingPage = Pick<WebContents, 'on' | 'removeListener'>

export interface ArrivalHold {
  /** The page took the keyboard since the hold began and nothing was pressed in it first: its first page committing, not the person clicking away. */
  arrivedWithKeyboard: () => boolean
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
  const onInput = (_event: unknown, input: { readonly type: string }): void => { if (input.type === 'mouseDown') pressed = true }
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
  return { arrivedWithKeyboard: () => tookKeyboard && !pressed, end }
}
