// A main-frame navigation to a `file:` address that nobody asked the shell for: a file dropped on a page, or a page's own
// attempt. Pure, apart from the one listener that applies it. A local page's link to another local file is left to the
// session fence (`../local-files/local-file-fence.ts`), which puts each file in the session it belongs in.
import type { WebContents } from 'electron'
import { localFileKey } from '../../broker/policy/origin.js'

export type FileNavigation = 'ignore' | 'allow' | 'open' | 'refuse'

export interface FileNavigationInput {
  readonly target: string
  /** The address the tab shows now. */
  readonly current: string
  readonly isMainFrame: boolean
  /** A page's script or link started it. False for the browser itself: a drop, or its own `loadURL`. */
  readonly byPage: boolean
}

export function fileNavigationFor ({ target, current, isMainFrame, byPage }: FileNavigationInput): FileNavigation {
  if (!isMainFrame || !/^file:/i.test(target)) return 'ignore'
  if (localFileKey(target) === null) return 'refuse'
  if (localFileKey(current) !== null) return 'allow'
  return byPage ? 'refuse' : 'open'
}

interface NavigationEvent {
  readonly url: string
  readonly isMainFrame: boolean
  readonly initiator?: unknown
  readonly preventDefault: () => void
}

/**
 * Applies `fileNavigationFor` to a tab's `will-navigate`: a dropped file is stopped and handed to `open`, which makes
 * it a local file in a tab of its own; a page's own navigation to a file is stopped. Wired before the tab's
 * partition check, which skips an event already prevented.
 */
export function watchFileNavigation (wc: Pick<WebContents, 'on' | 'getURL'>, open: (url: string) => void): void {
  wc.on('will-navigate', (event: NavigationEvent) => {
    const verdict = fileNavigationFor({ target: event.url, current: wc.getURL(), isMainFrame: event.isMainFrame, byPage: event.initiator !== null && event.initiator !== undefined })
    if (verdict === 'open' || verdict === 'refuse') event.preventDefault()
    if (verdict === 'open') open(event.url)
  })
}
