// A link clicked in another program reaches a running macOS app as an `open-url` event, never on its command line.
// It joins the queue a second launch's addresses join, so one rule decides what may be opened.
import { urlsFromArgv } from '../launch/launch-context.js'

export interface OpenUrlEvent {
  preventDefault: () => void
}

/** Claims the event and queues its address when it is an http or https one; any other scheme is dropped, as it is on a command line. */
export function handleOpenUrl (event: OpenUrlEvent, url: string, queue: (urls: string[]) => void): void {
  event.preventDefault()
  const urls = urlsFromArgv([url])
  if (urls.length > 0) queue(urls)
}
