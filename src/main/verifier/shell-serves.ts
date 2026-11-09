// Which of the origins the shell serves from a copy it keeps the verifier's server may hand to the shell: the ones whose
// host the server answers at all, on its one port. The registry is `loader/electron/app-partitions.ts`'s; the host is
// told this set, whole, whenever it starts and whenever it changes.

import { servedByVerifier } from '../../loader/fetch/verifier-origin.js'
import { ownReadToken } from '../../loader/fetch/own-read.js'
import { onServingChange, servedOrigins, servingHandlerFor } from '../../loader/electron/app-partitions.js'
import type { AppRequestHandler } from '../../loader/serve/serve.js'
import type { HostConfig, ShellServes, ToHost } from '../../protocols/verifier-host/protocol.js'
import { ShellResponder } from './shell-responder.js'

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

/** Whether the host hands requests for `origin` to the shell: the shell serves it and the host could be told so. */
export function isHandedToShell (origin: string): boolean {
  return relayHandlerFor(origin) !== undefined
}

/** What the host is started with: the secret that marks a read of the shell's own, and the origins it hands to the shell. */
export function hostShell (): NonNullable<HostConfig['shell']> {
  return { ownReadToken: ownReadToken(), origins: relayableOrigins() }
}

/** Tells the host the whole set it is to hand to the shell: at the host's report that it listens too, before the held requests are let go, so an origin served since its configuration was built is in its set. */
export function announceServed (host: { send: (message: ShellServes) => unknown }): void {
  host.send({ type: 'shell-serves', origins: relayableOrigins() })
}

/** Answers the host's relayed requests with the handlers the shell serves from, and tells it of every change in what the shell serves. */
export function serveShell (host: { send: (message: ToHost) => boolean }): ShellResponder {
  onServingChange(() => { announceServed(host) })
  return new ShellResponder({ send: (message) => host.send(message), handlerFor: relayHandlerFor })
}
