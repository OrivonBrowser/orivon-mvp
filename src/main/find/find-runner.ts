// The calls on a tab's WebContents. Nothing here decides anything: what to ask
// is ./find-session.ts, when to ask is ./find-window.ts.
import type { WebContents } from 'electron'
import type { FindCall } from './find-session.js'

/** Starts or steps a search and returns the id its answer will carry. A new search first clears the last one: asked again for the text it already holds (another case, another page), Chromium steps to the next match instead of starting over. */
export function runFind (wc: WebContents, call: FindCall): number {
  if (call.options.findNext) wc.stopFindInPage('clearSelection')
  return wc.findInPage(call.text, { ...call.options })
}

/** Ends the search. Keeping the selection leaves the active match selected in the page. */
export function stopFind (wc: WebContents | undefined, keepSelection: boolean): void {
  if (wc === undefined || wc.isDestroyed()) return
  wc.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection')
}

/** How long a page may take to say what is selected before the bar opens without it. */
const SELECTION_WAIT_MS = 150
/** A one-line selection this short is worth searching for. */
const MAX_PREFILL = 100

/** The page's selection, when it is one short line: the text a person selected before opening the bar. */
export async function selectedText (wc: WebContents): Promise<string> {
  if (wc.isDestroyed() || wc.isCrashed() || wc.isLoadingMainFrame()) return ''
  const read = wc.mainFrame.executeJavaScript('String(window.getSelection())').then((value: unknown) => typeof value === 'string' ? value : '', () => '')
  const timeout = new Promise<string>((resolve) => { setTimeout(() => { resolve('') }, SELECTION_WAIT_MS) })
  const text = (await Promise.race([read, timeout])).trim()
  return text.length > 0 && text.length < MAX_PREFILL && !/[\r\n]/.test(text) ? text : ''
}
