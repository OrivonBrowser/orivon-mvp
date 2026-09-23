// Which tab, if any, fills the window because its page called
// requestFullscreen(). The decision only: window.ts applies it. Electron puts
// the window itself into fullscreen and takes it out again; what it does not
// do is resize a WebContentsView or hide the chrome above it.

/** What window.ts does when the answer changes. */
export interface FullscreenEffects {
  /** Re-applies the chrome's and the active tab's bounds from `tabId`. */
  relayout: () => void
  /** Asks a live tab's page to leave fullscreen. Its leave event follows. */
  exitTab: (id: string) => void
  /** For a tab that no longer exists: no page is left to leave, so the
   * window has to be taken out of fullscreen directly. */
  leaveWindowFullscreen: () => void
  showNotice: () => void
  hideNotice: () => void
}

export class HtmlFullscreen {
  private current: string | null = null

  constructor (private readonly effects: FullscreenEffects) {}

  get tabId (): string | null {
    return this.current
  }

  /** A tab's page entered or left fullscreen (its webContents'
   * `enter-html-full-screen` / `leave-html-full-screen`). */
  changed (id: string, entered: boolean, activeId: string | null): void {
    if (entered) {
      // A click leaves the page a few seconds of activation, long enough for
      // the person to have switched tabs before the page asks. Filling the
      // window then would show a different tab's content in fullscreen.
      if (id !== activeId) {
        this.effects.exitTab(id)
        return
      }
      this.current = id
      this.effects.relayout()
      this.effects.showNotice()
      return
    }
    if (this.current !== id) return
    this.current = null
    this.effects.hideNotice()
    this.effects.relayout()
  }

  /** Called on every tab-state push: the fullscreen tab closing, crashing or
   * being switched away from ends fullscreen, whatever the page wants. */
  tabsChanged (activeId: string | null, isLive: (id: string) => boolean): void {
    const id = this.current
    if (id === null || id === activeId) return
    this.current = null
    this.effects.hideNotice()
    if (isLive(id)) this.effects.exitTab(id)
    else this.effects.leaveWindowFullscreen()
    this.effects.relayout()
  }
}
