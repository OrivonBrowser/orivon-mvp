// What happens when a server asks for a client certificate: the person chooses one of those the machine offers,
// in a sheet over the tab that made the request. Nothing is sent without a choice, and a request with no tab
// (a main-process fetch, an extension's page) is answered with no certificate. Pure over its dependencies.
import type { Certificate, WebContents } from 'electron'
import type { ShellWindow } from '../shell/window-registry.js'
import type { ChooserItem, ChooserSpec } from './chooser-store.js'

export interface ClientCertificateDeps {
  readonly findTab: (contents: WebContents) => { window: ShellWindow, tabId: string } | null
  readonly ask: (window: ShellWindow, tabId: string, spec: ChooserSpec) => Promise<string | null>
  /** Formats a date the way the person's system does. */
  readonly formatDate: (ms: number) => string
  readonly now: () => number
}

function hostOf (url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** One row of the chooser for one certificate; its id is its place in the list Electron handed over. */
export function certificateItem (certificate: Certificate, index: number, deps: Pick<ClientCertificateDeps, 'formatDate' | 'now'>): ChooserItem {
  const subject = certificate.subjectName !== '' ? certificate.subjectName : certificate.subject.organizations[0] ?? 'Certificate'
  const expires = certificate.validExpiry * 1000
  return {
    id: String(index),
    title: subject,
    sub: `Issued by ${certificate.issuerName !== '' ? certificate.issuerName : certificate.issuer.organizations[0] ?? 'an unknown issuer'}`,
    meta: expires < deps.now() ? `Expired ${deps.formatDate(expires)}` : `Expires ${deps.formatDate(expires)}`
  }
}

export function handleSelectClientCertificate (
  deps: ClientCertificateDeps,
  event: { preventDefault: () => void },
  contents: WebContents | null | undefined,
  url: string,
  list: readonly Certificate[],
  callback: (certificate?: Certificate) => void
): void {
  // Without this Electron answers with the first certificate in the store, which would hand a stranger an identity.
  event.preventDefault()
  const found = contents === null || contents === undefined ? null : deps.findTab(contents)
  if (found === null || list.length === 0) {
    callback()
    return
  }
  const host = hostOf(url)
  void deps.ask(found.window, found.tabId, {
    title: 'Choose a certificate',
    origin: host,
    line: `${host} asks you to identify yourself with a certificate.`,
    confirm: 'Use certificate',
    empty: 'No certificates are installed on this computer.',
    items: list.map((certificate, index) => certificateItem(certificate, index, deps))
  }).then((choice) => {
    // Only an index that was offered can come back; anything else sends no certificate.
    const chosen = choice !== null && /^\d{1,4}$/.test(choice) ? list[Number(choice)] : undefined
    if (chosen === undefined) callback()
    else callback(chosen)
  }, () => { callback() })
}
