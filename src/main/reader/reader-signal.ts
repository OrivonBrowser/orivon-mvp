// Whether the page in a tab looks like an article, so the address bar can offer reader view. The page is
// asked once per address when it has stopped loading; a page that has not been asked, or has moved on, is
// not readable.
import type { WebContents } from 'electron'
import type { TabSignal } from '../shell/tab-signals.js'
import type { TabRecord } from '../shell/tab-types.js'
import { checkReadable } from './reader-extract.js'

interface Verdict { readonly url: string, readable: boolean }

const verdicts = new WeakMap<WebContents, Verdict>()

const WEB_URL = /^https?:\/\//i

/** An ordinary website in the default session: not one of the shell's pages, and not an app. */
export function eligible (record: TabRecord, url: string): boolean {
  return record.internalPage === null && !record.isDashboardTab && record.partition === undefined && record.reader == null && WEB_URL.test(url)
}

export function readableNow (wc: WebContents | undefined): boolean {
  if (wc === undefined || wc.isDestroyed()) return false
  const verdict = verdicts.get(wc)
  return verdict !== undefined && verdict.readable && verdict.url === wc.getURL()
}

export const readerSignal: TabSignal = {
  name: 'reader',
  wire: ({ record, wc, shown }) => {
    const ask = (): void => {
      if (!shown()) return
      const url = wc.getURL()
      if (!eligible(record, url) || verdicts.get(wc)?.url === url) return
      const verdict: Verdict = { url, readable: false }
      verdicts.set(wc, verdict)
      void checkReadable(wc).then((readable) => {
        verdict.readable = readable
        if (readable && shown() && wc.getURL() === url) record.host.emitState()
      })
    }
    wc.on('did-stop-loading', ask)
    wc.on('did-navigate-in-page', ask)
  },
  state: (_record, wc) => ({ readable: readableNow(wc) })
}
