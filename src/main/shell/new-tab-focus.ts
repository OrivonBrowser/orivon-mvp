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
  focusAddressBar: () => void
}

/** A new tab in front starts with the keyboard in the address bar, not in its own page. */
export function wantsAddressBar (input: NewTabFocusInput): boolean {
  return input.active && input.freshNewTab && input.windowFocused && !input.coveredByIntro
}

/** Gives the bar the keyboard at creation, and once more just after the tab's page takes it at its first commit, or at
 * the end of its load if it never did. The second turn is the page's own doing, which no call at creation can pre-empt. */
export function watchNewTab (contents: Pick<WebContents, 'on' | 'removeListener' | 'isDestroyed'>, deps: NewTabWatchDeps): void {
  if (wantsAddressBar(deps.input())) deps.focusAddressBar()
  const settle = (): void => {
    contents.removeListener('focus', settle)
    contents.removeListener('did-finish-load', settle)
    setImmediate(() => {
      if (!contents.isDestroyed() && wantsAddressBar(deps.input())) deps.focusAddressBar()
    })
  }
  contents.on('focus', settle)
  contents.on('did-finish-load', settle)
}
