// A link clicked in another program reaches a running macOS app as an `open-url` event, never on its command line.
// It joins the queue a second launch's addresses join, so one rule decides what may be opened.
import { urlsFromArgv } from '../launch/launch-context.js'
import { openableOrivonLink } from '../launch/orivon-link.js'

export interface OpenUrlEvent {
  preventDefault: () => void
}

/**
 * Claims the event and queues its address when it is an http or https one, or an `orivon:open` link that names a `.eth`
 * name or an ipfs:// or ipns:// address; any other scheme is dropped, as it is on a command line. A flavour the link
 * carries goes along as the second argument.
 */
export function handleOpenUrl (event: OpenUrlEvent, url: string, queue: (urls: string[], flavour?: string) => void): void {
  event.preventDefault()
  const urls = urlsFromArgv([url])
  if (urls.length > 0) {
    queue(urls)
    return
  }
  const link = openableOrivonLink(url)
  if (link === undefined) return
  if (link.flavour === undefined) queue([link.url])
  else queue([link.url], link.flavour)
}
