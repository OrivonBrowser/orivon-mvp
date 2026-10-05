import type { WebContents } from 'electron'

/**
 * Orivon patch (UPSTREAM.md patch 68): a popup opened while the page behind it is mid-navigation. The
 * page that commits takes the keyboard natively, so the popup blurs a few milliseconds before the
 * commit is reported (measured), and any blur closes a popup. Chrome's popup is a window of its own
 * and a commit does not reach it; this one is a view in the same window.
 *
 * The guard follows that one navigation: it absorbs blurs until the page reports the main frame
 * committed, failed or stopped loading (or went away), unless a mouse button went down in the window
 * meanwhile, which is a person leaving the popup and closes it as always. When the navigation ends
 * having absorbed a blur, `onSettled` says the popup should take the keyboard back.
 */
export class NavigationGuard {
  private ended = false
  private clicked = false
  private absorbed = false
  private readonly detach: Array<() => void> = []

  /** `views` are the window's own pages, where a click can land; `page` is the one navigating. */
  constructor (
    page: WebContents,
    views: Iterable<WebContents>,
    private readonly onSettled: () => void,
    private readonly onClick: () => void,
  ) {
    const settle = (): void => {
      if (this.ended) return
      this.dispose()
      if (this.absorbed && !this.clicked) this.onSettled()
    }
    const onFail = (_event: unknown, _code: number, _description: string, _url: string, isMainFrame: boolean): void => {
      if (isMainFrame) settle()
    }
    page.on('did-navigate', settle)
    page.on('did-stop-loading', settle)
    page.on('destroyed', settle)
    page.on('did-fail-load', onFail)
    this.detach.push(() => {
      page.removeListener('did-navigate', settle)
      page.removeListener('did-stop-loading', settle)
      page.removeListener('destroyed', settle)
      page.removeListener('did-fail-load', onFail)
    })

    const onInput = (_event: unknown, input: { type: string }): void => {
      if (input.type !== 'mouseDown' || this.clicked) return
      this.clicked = true
      if (this.absorbed) this.onClick()
    }
    for (const view of new Set(views)) {
      view.on('input-event', onInput)
      this.detach.push(() => { view.removeListener('input-event', onInput) })
    }
  }

  /** True when this blur is the commit's and the popup stays open. */
  absorbsBlur (): boolean {
    if (this.ended || this.clicked) return false
    this.absorbed = true
    return true
  }

  /** Stops following the page. */
  dispose (): void {
    this.ended = true
    for (const detach of this.detach.splice(0)) detach()
  }
}
