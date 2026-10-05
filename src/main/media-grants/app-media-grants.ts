// A registered app's camera, microphone and screen grants as the permission gate and the display gate read them
// (ADR-0032, ADR-0055). Pure over its two dependencies, so every branch is unit-tested with fakes.
import type { WebContents } from 'electron'
import type { AppMediaGrants, AppMediaKind } from '../display-capture/types.js'

export interface AppMediaGrantsDeps {
  /** Granted now, read from the ledger. */
  held: (origin: string, kind: AppMediaKind) => boolean
  /** The run-time question. False without asking for a kind the manifest does not declare or one the person revoked. */
  ask: (tab: WebContents, origin: string, kind: AppMediaKind) => Promise<boolean>
}

interface Denied {
  origin: string
  kinds: Set<AppMediaKind>
}

export function createAppMediaGrants (deps: AppMediaGrantsDeps): AppMediaGrants {
  /** What the person refused on the page a tab shows now: a page that asks again meets the same no until it loads again. */
  const denied = new WeakMap<WebContents, Denied>()

  function deny (tab: WebContents, origin: string, kind: AppMediaKind): void {
    const known = denied.get(tab)
    if (known === undefined) {
      denied.set(tab, { origin, kinds: new Set([kind]) })
      tab.on('did-navigate', () => { denied.delete(tab) })
    } else if (known.origin === origin) {
      known.kinds.add(kind)
    } else {
      known.origin = origin
      known.kinds = new Set([kind])
    }
  }

  const wasDenied = (tab: WebContents, origin: string, kind: AppMediaKind): boolean => {
    const known = denied.get(tab)
    return known !== undefined && known.origin === origin && known.kinds.has(kind)
  }

  return {
    held: deps.held,
    async request (tab, origin, kind) {
      if (deps.held(origin, kind)) return true
      if (wasDenied(tab, origin, kind)) return false
      const allowed = await deps.ask(tab, origin, kind)
      if (!allowed) deny(tab, origin, kind)
      return allowed
    }
  }
}
