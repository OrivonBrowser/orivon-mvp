// Watches one tab's web contents for a page that failed to load, and puts the sheet over the tab. Chromium shows a
// failed load as an empty page under the address that failed, so without the sheet nothing says it failed. The sheet
// belongs to that failure only: the tab's next navigation, or other web contents taking the tab's place, takes it, or
// its place in the queue, away.
import type { WebContents } from 'electron'
import { isCertError } from '../auth/cert-error-text.js'
import type { requestSlot } from '../overlays/tab-slots.js'
import type { LoadRefusal } from '../route/load-refusals.js'
import type { RefusalWord } from '../route/name-relay/relay-failures.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { isErrorName } from './load-error-text.js'

export const LOAD_ERROR_OVERLAY = 'load-error'

/** A navigation cancelled by a newer one, by the person, or because it became a download: the page did not fail. */
const ERR_ABORTED = -3

export interface LoadErrorDeps {
  readonly findTab: (contents: WebContents) => { window: ShellWindow, tabId: string } | null
  readonly ask: typeof requestSlot
  /** Another sheet explains this failure (HTTPS-only upgraded the address and the upgrade failed), so this one stays out. */
  readonly claimed?: (contentsId: number, url: string, code: number) => boolean
  /** Why Orivon cancelled this load before sending it (an onion address outside the person's own SOCKS5 tunnel, a name the verifier serves that the system's proxy would see), which the sheet then says; undefined for any other failure. */
  readonly refused?: (contentsId: number, url: string) => LoadRefusal | undefined
  /** Why the name relay did not carry the secure connection this failed load was for, as one of its words, when it noted one: Chromium names such a failure a tunnel that did not connect, and the sheet says the switch is why. */
  readonly relay?: (url: string, code: number) => RefusalWord | undefined
  /** The tab is about to move to another session and load this address there, so the failure is not the page's last word. Asked with the partition the tab is in now. */
  readonly movesTab?: (partition: string | undefined, url: string, code: number) => boolean
}

const refusalPayload = (refusal: LoadRefusal | undefined): { refusal?: LoadRefusal } => refusal === undefined ? {} : { refusal }
const relayPayload = (relay: RefusalWord | undefined): { relay?: RefusalWord } => relay === undefined ? {} : { relay }

/** Each watched web contents, with what takes its sheet away. */
const watched = new WeakMap<WebContents, () => void>()

/** Other web contents took the tab's place (a first visit let in as an app, a sleeping tab): this one's sheet is about a page the tab no longer shows. */
export function forgetLoadErrors (contents: WebContents): void {
  watched.get(contents)?.()
}

export function watchLoadErrors (contents: WebContents, deps: LoadErrorDeps): void {
  if (watched.has(contents)) return
  let pending: { cancel: () => void } | undefined
  const withdraw = (): void => {
    pending?.cancel()
    pending = undefined
  }
  watched.set(contents, withdraw)
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) withdraw()
  })
  contents.on('did-fail-load', (_event, code, name, url, isMainFrame) => {
    // A failure that committed no error page (the page before it is still showing) reads another address.
    if (!isMainFrame || code === ERR_ABORTED || isCertError(code) || contents.getURL() !== url) return
    const found = deps.findTab(contents)
    if (found === null || deps.claimed?.(contents.id, url, code) === true) return
    if (deps.movesTab?.(found.window.tabs.partitionOf(found.tabId), url, code) === true) return
    withdraw()
    pending = deps.ask({
      window: found.window,
      tabId: found.tabId,
      slot: 'center',
      overlay: LOAD_ERROR_OVERLAY,
      payload: { code, name: isErrorName(name) ? name : '', ...refusalPayload(deps.refused?.(contents.id, url)), ...relayPayload(deps.relay?.(url, code)) },
      closed: () => { pending = undefined }
    })
  })
}
