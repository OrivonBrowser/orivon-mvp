// The relay's listener, assembled: `front.ts` on loopback with a secret of its own, whose `open` is the relay's opener over the
// system's answer and the lookups it is handed. Each refusal is counted and worded by `relay-failures.ts` and reaches the log
// through `onRefused`, as a word. Free of Electron: the sessions are the caller's.

import { startRouteFront } from '../front.js'
import type { RelayListener } from './relay-switch.js'
import { createRelayOpener } from './relay-opener.js'
import type { DirectLookup } from './relay-opener.js'
import type { NameLookup, ProxyEntry } from './proxied-lookup.js'
import type { RefusalWord, RelayFailures } from './relay-failures.js'

export interface RelayListenerDeps {
  /** Which proxy the system names for a URL: T20's `resolveProxy` string, and never one that ran a script of the system's with a name the verifier serves. */
  readonly systemAnswer: (url: string) => Promise<string>
  readonly lookup: NameLookup
  readonly drop: (host: string, via: ProxyEntry) => void
  /** The addresses this computer's resolver gives a host the system sends outside any proxy. */
  readonly lookupDirect: DirectLookup
  readonly failures: RelayFailures
  /** Called with the word of every connection the relay stopped. */
  readonly onRefused?: (word: RefusalWord) => void
}

/** Starts a listener on loopback. `onClosed` is called when it stops listening. */
export async function startRelayListener (deps: RelayListenerDeps, onClosed: () => void): Promise<RelayListener & { readonly port: number }> {
  const failures: RelayFailures = {
    ...deps.failures,
    note: (host, port, word) => {
      deps.failures.note(host, port, word)
      deps.onRefused?.(word)
    }
  }
  const open = createRelayOpener({ systemAnswer: deps.systemAnswer, lookup: deps.lookup, drop: deps.drop, lookupDirect: deps.lookupDirect, failures })
  const front = await startRouteFront({ open, onClosed })
  return { port: front.port, username: front.username, secret: front.secret, stop: front.drain, close: front.close }
}
