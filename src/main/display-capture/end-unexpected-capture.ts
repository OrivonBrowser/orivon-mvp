// The backstop for a `media` grant that turned out not to be a display request. A grant given against a ticket always
// reaches the display handler inside the same call; one that did not is a legacy capture (`getUserMedia` with
// `chromeMediaSource`) that took the grant meant for the wrapped call, which only ending the page's document ends.
// Provisional: the tab is reloaded; whether to end its renderer instead is an open question.
import type { WebContents } from 'electron'

export function endUnexpectedCapture (contents: Pick<WebContents, 'reload' | 'isDestroyed' | 'getURL'>): void {
  if (contents.isDestroyed()) return
  console.error('[display-capture] a granted capture request reached no display handler; the tab is reloaded:', contents.getURL())
  contents.reload()
}
