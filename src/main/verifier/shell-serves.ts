// Which of the origins the shell serves from a copy it keeps the verifier's server may hand to the shell: the ones whose
// host the server answers at all, on its one port. The registry is `loader/electron/app-partitions.ts`'s; the host is
// told this set, whole, whenever it starts and whenever it changes.

import { servedByVerifier } from '../../loader/fetch/verifier-origin.js'
import { servedOrigins, servingHandlerFor } from '../../loader/electron/app-partitions.js'
import type { AppRequestHandler } from '../../loader/serve/serve.js'

/** An `https:` origin of a host a protocol serves, on the default port: the only kind the verifier's server is asked for. */
export function isRelayable (origin: string): boolean {
  try {
    return servedByVerifier(origin) && new URL(origin).port === ''
  } catch {
    return false
  }
}

/** The origins the host is to hand to the shell. */
export function relayableOrigins (): readonly string[] {
  return servedOrigins().filter(isRelayable)
}

/** The handler a relayed request for `origin` is answered with, when the shell serves it and the host could have been told so. */
export function relayHandlerFor (origin: string): AppRequestHandler | undefined {
  return isRelayable(origin) ? servingHandlerFor(origin) : undefined
}
