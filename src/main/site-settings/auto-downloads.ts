// A page that starts a second download on its own: no click, no key press,
// and an earlier download on the same page load. The first is the page's
// business; the next ones are the person's to allow, so the download waits
// while they are asked. A download the person asked for (a click) never waits.
// Tied to Electron only through the `DownloadItem` it is handed.
import type { DownloadItem, WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { StartInfo } from '../downloads/download-service.js'
import type { SiteKind } from './kinds.js'
import type { PageAccess } from './page-access.js'
import type { SiteAnswer } from './site-asks-engine.js'
import type { SiteDecision, SiteSettingsStore } from './site-settings-store.js'

export interface AutoDownloadsDeps {
  readonly store: Pick<SiteSettingsStore, 'get' | 'set'>
  /** What a site gets when it has no answer of its own: `block` refuses without asking. */
  readonly defaultFor: () => 'ask' | 'block'
  /** A registered app's origin: its downloads are its own business. */
  readonly isApp: (origin: string) => boolean
  /** An ordinary tab, as opposed to an embed, an extension's page or a shell view. */
  readonly isTab: (contents: WebContents) => boolean
  readonly ask: (kinds: readonly SiteKind[], tab: WebContents) => Promise<SiteAnswer>
  readonly access: PageAccess<WebContents>
}

interface Document {
  /** Downloads this page load has started, whatever started them. */
  started: number
  /** The question already open for this tab: every download that waits shares its answer. */
  question: Promise<SiteAnswer> | null
}

const KIND: SiteKind = 'autoDownloads'

export function createAutoDownloads (deps: AutoDownloadsDeps): (info: StartInfo) => void {
  const documents = new WeakMap<WebContents, Document>()

  function documentOf (tab: WebContents): Document {
    let document = documents.get(tab)
    if (document === undefined) {
      document = { started: 0, question: null }
      documents.set(tab, document)
      // Main frame only, and not for in-page navigations: exactly a new page load.
      tab.on('did-navigate', () => { documents.set(tab, { started: 0, question: null }) })
    }
    return document
  }

  function refuse (item: DownloadItem): void {
    try { item.cancel() } catch (error) { console.error('[auto-downloads] could not cancel a download:', error) }
  }

  async function decide (item: DownloadItem, tab: WebContents, origin: string, document: Document): Promise<void> {
    const stored: SiteDecision | undefined = deps.store.get(origin, KIND)
    if (stored === 'allow') return
    if (stored === 'block' || deps.defaultFor() === 'block') {
      deps.access.note(tab, origin, KIND, 'blocked')
      refuse(item)
      return
    }
    try { item.pause() } catch { /* a download that already finished has nothing to hold */ }
    document.question ??= deps.ask([KIND], tab)
    const answer = await document.question
    if (tab.isDestroyed()) { refuse(item); return }
    if (answer === 'allow' || answer === 'block') {
      deps.store.set(origin, KIND, answer)
      deps.access.note(tab, origin, KIND, answer === 'allow' ? 'allowed' : 'blocked')
    }
    if (answer === 'allow') {
      try { item.resume() } catch { /* cancelled by the person meanwhile */ }
    } else {
      refuse(item)
    }
  }

  return ({ item, contents, userGesture }) => {
    if (contents === undefined || contents.isDestroyed() || !deps.isTab(contents)) return
    const document = documentOf(contents)
    const earlier = document.started
    document.started += 1
    if (userGesture || earlier === 0) return
    const pageUrl = contents.getURL()
    const origin = pageUrl.startsWith('http') ? originFromUrl(pageUrl) : null
    if (origin === null || deps.isApp(origin)) return
    void decide(item, contents, origin, document).catch((error: unknown) => {
      console.error('[auto-downloads] the decision failed; the download is cancelled:', error)
      refuse(item)
    })
  }
}
