// `web.embed`'s broker half (ADR-0039): what the shell's embed host asks
// before it lets a `<webview>` attach or load a document, and the one page
// call, `orivon.web.setEmbedScript`. Built the same shape as ./web.ts: no
// state beyond one map, no Electron, revocation through the shared
// HandleTable -- a shown page is a handle of kind 'embed' under the grant,
// so `HandleTable.revoke` closes it the way it closes a socket.

import { LIMITS } from '../../contracts/index.js'
import type { Pattern } from '../../contracts/index.js'
import { fail } from '../errors.js'
import { isolationKeyFromUrl } from '../policy/origin.js'
import type { HandleTable } from '../handles/handles.js'
import type { GrantLedger } from '../grants/grant-ledger.js'
import type { ListenerRegistry } from './listener-registry.js'
import type { BrokerEmbedMethods } from '../embed-contracts.js'

export interface EmbedCapabilityOptions {
  readonly handleTable: HandleTable
  readonly ledger: GrantLedger
  /** ../index.ts's own `canonical`, shared rather than redefined here. */
  readonly canonical: (origin: string) => string
  /** The listeners `orivon.net.listen` registered, which a local pattern's port is checked against (ADR-0047). */
  readonly listeners: ListenerRegistry
}

/** UTF-8 byte length, the unit `LIMITS.embedScriptBytes` is measured in. */
function utf8Bytes (text: string): number {
  return new TextEncoder().encode(text).length
}

/** Builds `Broker['embed']` -- see this file's header. */
export function createEmbedCapability ({ handleTable, ledger, canonical, listeners }: EmbedCapabilityOptions): BrokerEmbedMethods {
  const scripts = new Map<string, string>()

  function originsSync (origin: string): readonly Pattern[] | undefined {
    const key = isolationKeyFromUrl(origin)
    if (key === null) return undefined
    return ledger.currentGrant(key, 'web.embed')?.patterns
  }

  function holdsListenerSync (origin: string, port: number): boolean {
    const key = isolationKeyFromUrl(origin)
    return key !== null && listeners.holds(key, port)
  }

  function scriptSync (origin: string): string | undefined {
    const key = isolationKeyFromUrl(origin)
    if (key === null || ledger.currentGrant(key, 'web.embed') === undefined) return undefined
    return scripts.get(key)
  }

  function attach (origin: string, destroy: () => void): { readonly release: () => void } {
    const key = canonical(origin)
    const current = ledger.currentGrant(key, 'web.embed')
    if (current === undefined) {
      destroy()
      throw fail('denied', 'web.embed is not granted to this origin')
    }
    const entry = handleTable.acquire({
      origin: key,
      kind: 'embed',
      authorisedBy: { by: 'grant', grantId: current.id },
      destroy: async () => { destroy() }
    })
    return { release: () => { void handleTable.release(key, entry.id) } }
  }

  async function setScript (origin: string, opts: { source: string }): Promise<void> {
    const key = canonical(origin)
    if (ledger.currentGrant(key, 'web.embed') === undefined) throw fail('denied', 'web.embed is not granted to this origin')
    if (typeof opts.source !== 'string') throw fail('invalid', 'source must be a string')
    if (utf8Bytes(opts.source) > LIMITS.embedScriptBytes) {
      throw fail('limit', `script exceeds ${String(LIMITS.embedScriptBytes)} bytes`)
    }
    if (opts.source === '') scripts.delete(key)
    else scripts.set(key, opts.source)
  }

  /** See this method's own doc (embed-contracts.ts). */
  function forgetScript (key: string): void {
    scripts.delete(key)
  }

  return { originsSync, holdsListenerSync, onListenerClosed: listeners.onLastForgotten, scriptSync, attach, setScript, forgetScript }
}
