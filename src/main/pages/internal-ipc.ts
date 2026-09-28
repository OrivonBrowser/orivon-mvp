// The one channel internal pages speak to main on. Every call is checked
// against what the shell knows, not against anything the caller claims: the
// sender must be a top frame the shell opened as an internal page, in the
// internal session, sitting on that page's own address, and must ask for a
// domain that page is allowed. A refusal is silent, like the other channels',
// so a page probing for the channel learns nothing.
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent, Session, WebContents } from 'electron'
import { INTERNAL_COMMAND_CHANNEL } from '../channels.js'
import { INTERNAL_SCHEME } from './internal-pages.js'
import type { InternalPageId } from './internal-pages.js'
import type { InternalPageRegistry } from './internal-registry.js'

export interface InternalCaller {
  readonly page: InternalPageId
  readonly contents: WebContents
}

export interface InternalDomain {
  /** The pages that may use this domain. */
  readonly pages: readonly InternalPageId[]
  handle: (command: unknown, caller: InternalCaller) => unknown
}

export interface CallFacts {
  readonly isTopFrame: boolean
  readonly frameUrl: string
  /** The page the shell opened this webContents as, if it did. */
  readonly registeredAs: InternalPageId | undefined
  readonly inInternalSession: boolean
}

/** The page a call comes from, or null when it must be refused. */
export function authorizeCall (facts: CallFacts): InternalPageId | null {
  if (!facts.isTopFrame || !facts.inInternalSession || facts.registeredAs === undefined) return null
  let url: URL
  try {
    url = new URL(facts.frameUrl)
  } catch {
    return null
  }
  // The address the shell opened it at: a page that has navigated elsewhere,
  // to another internal page included, is no longer the page it was.
  return url.protocol === `${INTERNAL_SCHEME}:` && url.hostname === facts.registeredAs ? facts.registeredAs : null
}

interface Envelope {
  readonly domain: string
  readonly command: unknown
}

function isEnvelope (value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && typeof (value as { domain?: unknown }).domain === 'string'
}

/** Once per process: `ipcMain.handle` refuses a second registration. */
export function registerInternalIpc (
  registry: InternalPageRegistry,
  internalSession: () => Session | undefined,
  domains: Readonly<Record<string, InternalDomain>>
): void {
  ipcMain.handle(INTERNAL_COMMAND_CHANNEL, async (event: IpcMainInvokeEvent, envelope: unknown): Promise<unknown> => {
    const frame = event.senderFrame
    if (frame === null) return undefined
    const page = authorizeCall({
      isTopFrame: frame === event.sender.mainFrame,
      frameUrl: frame.url,
      registeredAs: registry.pageOf(event.sender),
      inInternalSession: event.sender.session === internalSession()
    })
    if (page === null || !isEnvelope(envelope) || !Object.hasOwn(domains, envelope.domain)) return undefined
    const domain = domains[envelope.domain] as InternalDomain
    if (!domain.pages.includes(page)) return undefined
    return await domain.handle(envelope.command, { page, contents: event.sender })
  })
}

