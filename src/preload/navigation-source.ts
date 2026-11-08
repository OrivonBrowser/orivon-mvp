// Notes what started each navigation the page makes, and what the document says about its referrer policy, and sends it
// to main as the navigation begins, so that when the shell stops a navigation to move the tab to another session it can send
// the referrer Chromium would have (src/main/shell/initiator-referrer.ts). The platform's own `navigate` event names the element
// behind a link click or a form submit, and none behind a script, in every navigation the document starts. The document's
// policy has no DOM property, so the `<meta name="referrer">` values it has ever held are sent too (a removed tag leaves its
// policy in force). Nothing is exposed to the page.
import { ipcRenderer } from 'electron'
import { inMainFrame } from './frame.js'

/** Sent to the main process with each navigation to another document (src/main/shell/initiator-referrer.ts holds the same name; a unit test keeps the two equal). */
export const NAVIGATION_NOTE_CHANNEL = 'orivon-navigation:note'

const XHTML = 'http://www.w3.org/1999/xhtml'

interface NavigateEventLike {
  /** False for an event a page script made up. */
  readonly isTrusted: boolean
  readonly destination: { readonly url: string, readonly sameDocument: boolean }
  /** Absent where the engine does not name the source; null for a navigation no element started. */
  readonly sourceElement?: Element | null
}

interface NavigationLike {
  addEventListener: (type: 'navigate', listener: (event: NavigateEventLike) => void) => void
}

type Source = { kind: 'script' } | { kind: 'element', tag: string, rel: string | null, referrerPolicy: string | null } | undefined

/** More values than this are a page that cycles its tag: the report then holds one no policy is spelled as, which reads as unknown. */
const MAX_META_VALUES = 16

/** The link or form behind `element`: a submit button stands for its form. */
function ownerOf (element: Element): Element {
  const form = (element as { form?: unknown }).form
  return form instanceof Element ? form : element
}

function describe (event: NavigateEventLike): Source {
  if (!('sourceElement' in event)) return undefined
  const element = event.sourceElement
  if (element === null || element === undefined) return { kind: 'script' }
  const owner = ownerOf(element)
  return { kind: 'element', tag: owner.namespaceURI === XHTML ? owner.localName : '', rel: owner.getAttribute('rel'), referrerPolicy: owner.getAttribute('referrerpolicy') }
}

/** Every `content` a `<meta name="referrer">` of this document has had, from the first node parsed. */
function watchMetaPolicies (): () => string[] {
  const seen = new Set<string>()
  const note = (node: Node): void => {
    if (node instanceof HTMLMetaElement) {
      if (node.name.toLowerCase() === 'referrer') seen.add(seen.size < MAX_META_VALUES ? node.content : '?')
    } else if (node instanceof Element && node.firstElementChild !== null) {
      // An element with nothing inside holds no tag; a page that adds thousands of nodes pays for the containers only.
      for (const meta of node.querySelectorAll('meta')) note(meta)
    }
  }
  const handle = (records: MutationRecord[]): void => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLMetaElement) note(record.target)
      } else {
        record.addedNodes.forEach(note)
      }
    }
  }
  const observer = new MutationObserver(handle)
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['name', 'content'] })
  if (document.documentElement !== null) note(document.documentElement)
  return () => {
    handle(observer.takeRecords())
    return [...seen]
  }
}

/** Starts noting navigations and policies in this document. Top frame only: a subframe's navigations are left unreported, and main sends no referrer for them. */
export function installNavigationSource (): void {
  if (!inMainFrame()) return
  const navigation = (globalThis as { navigation?: NavigationLike }).navigation
  if (navigation === undefined) return
  const documentUrl = location.href
  const metaPolicies = watchMetaPolicies()
  navigation.addEventListener('navigate', (event) => {
    // A script can build a NavigateEvent of its own and dispatch it; only the browser's say what started a navigation. A move inside the document is no navigation to another session.
    if (!event.isTrusted || event.destination.sameDocument) return
    ipcRenderer.send(NAVIGATION_NOTE_CHANNEL, { href: document.URL, documentUrl, metaPolicies: metaPolicies(), destination: event.destination.url, source: describe(event) })
  })
}
