// Which view holds the keyboard after a new tab opens in front. Tied to Electron: the keyboard is a webContents' focus.
import type { WebContents } from 'electron'

export interface NewTabFocusInput {
  /** The tab is the one in front. */
  active: boolean
  /** The tab is still on its start page. */
  freshNewTab: boolean
  /** The window has the OS focus: on Linux `webContents.focus()` raises the window, so an unfocused one is left alone. */
  windowFocused: boolean
  /** The welcome screen is over the window and holds the keyboard until it is entered. */
  coveredByIntro: boolean
}

export interface NewTabWatchDeps {
  input: () => NewTabFocusInput
  /** Gives the bar the keyboard and selects its text: the field is empty at creation, so selecting costs nothing there. */
  focusAddressBar: () => void
  /** Hands the keyboard back to the chrome's page without touching the field: what is typed in the bar by then stays. */
  returnKeyboard: () => void
  /** The keyboard's own moves are over, once: the page has taken it and it went back to the chrome, or the load ended, failed or was abandoned. A popup that opens before this loses the keyboard to the page's grab and closes as a click away does. */
  placed?: () => void
}

/** A new tab in front starts with the keyboard in the address bar, not in its own page. */
export function wantsAddressBar (input: NewTabFocusInput): boolean {
  return input.active && input.freshNewTab && input.windowFocused && !input.coveredByIntro
}

/** Gives the bar the keyboard at creation, and returns it to the chrome just after the tab's page takes it at its first
 * commit, or at the end of its load if it never did. The second turn is the page's own doing, which no call at creation
 * can pre-empt; it keeps what has been typed in the bar since, so it never selects the field again. `placed` says when
 * the keyboard has stopped moving by itself. */
export function watchNewTab (contents: Pick<WebContents, 'on' | 'removeListener' | 'isDestroyed'>, deps: NewTabWatchDeps): void {
  if (wantsAddressBar(deps.input())) deps.focusAddressBar()
  let placed = false
  const finish = (): void => {
    if (placed) return
    placed = true
    deps.placed?.()
  }
  const settle = (): void => {
    contents.removeListener('focus', settle)
    contents.removeListener('did-finish-load', settle)
    contents.removeListener('did-fail-load', settle)
    setImmediate(() => {
      if (!contents.isDestroyed() && wantsAddressBar(deps.input())) deps.returnKeyboard()
      finish()
    })
  }
  contents.on('focus', settle)
  contents.on('did-finish-load', settle)
  contents.on('did-fail-load', settle)
  contents.on('destroyed', finish)
}

/**
 * What waits for a new tab's keyboard to be placed (`placed` above), by tab id. A new tab's page takes the keyboard in its first
 * moments, and a popup that is open then loses it and closes as a click away does, so what a press opens in that moment waits here.
 * Every `run` is called once, or cancelled.
 */
export class KeyboardWaiters {
  private readonly waiting = new Map<string, Array<() => void>>()

  /** A tab opened on the start page starts waiting for its keyboard. */
  begin (id: string): void { this.waiting.set(id, []) }

  /** The keyboard is placed, or the tab has left the books: runs what waits on it, whose caller then finds no tab. */
  release (id: string): void {
    const runs = this.waiting.get(id)
    this.waiting.delete(id)
    for (const run of runs ?? []) run()
  }

  /** Runs `run` once tab `id`'s keyboard is placed, and at once for a tab that is not waiting. Returns what cancels a `run` still waiting, undefined when it ran. */
  whenPlaced (id: string, run: () => void): (() => void) | undefined {
    const runs = this.waiting.get(id)
    if (runs === undefined) {
      run()
      return undefined
    }
    runs.push(run)
    return () => {
      const at = runs.indexOf(run)
      if (at !== -1) runs.splice(at, 1)
    }
  }
}
