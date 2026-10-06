// The backstop for a capture that may not be the one the person picked: a `media` grant that reached no display
// handler (a legacy capture took the grant meant for the wrapped call), or a request with no ticket right after a
// served one (the served request may have been the page's). Only ending the page's renderer ends what the page was
// handed: a reload leaves the old document running until the new one commits, and the page's server sets how long.
// The tab then shows the sad-tab card, and the share registry ends a share whose requester's renderer is gone.
import type { WebContents } from 'electron'

export function endUnexpectedCapture (contents: Pick<WebContents, 'forcefullyCrashRenderer' | 'isDestroyed' | 'getURL'>, reason: string): void {
  if (contents.isDestroyed()) return
  console.error(`[display-capture] ${reason}; the tab's renderer is ended:`, contents.getURL())
  contents.forcefullyCrashRenderer()
}
