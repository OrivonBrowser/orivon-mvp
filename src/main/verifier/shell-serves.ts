// Which of the origins the shell serves from a copy it keeps the verifier's server may hand to the shell: the ones whose
// host the server answers at all, on its one port. The registry is `loader/electron/app-partitions.ts`'s; the host is
// told this set, whole, whenever it starts and whenever it changes.

import { servedByVerifier } from '../../loader/fetch/verifier-origin.js'
import { ownReadToken } from '../../loader/fetch/own-read.js'
import { onServingChange, servedOrigins, servingHandlerFor } from '../../loader/electron/app-partitions.js'
import { OWN_READ_HEADER } from '../../loader/fetch/content-root.js'
import { isOwnSiteRequest, requestHeader } from '../../loader/fetch/own-site-request.js'
import type { RequestHeaders } from '../../loader/fetch/own-site-request.js'
import type { AppRequestHandler } from '../../loader/serve/serve.js'
import type { HostConfig, ShellServes, ToHost } from '../../protocols/verifier-host/protocol.js'
import { ShellResponder } from './shell-responder.js'
import { exposeServedHold, servedAnnouncementHeld } from './test-seam.js'

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

/**
 * Whether the host hands the request for `url` to the shell, as `ShellRelay.wants` decides it: the shell serves the origin, the
 * request is not a read of the shell's own, and the browser made it for the site. Asked by the session that makes the request,
 * with the headers it is about to send (the partition stamp among them), to keep it out of its HTTP cache. A tunnel profile's
 * request is the shell's like any other: its handler checks every file, and its reads leave by that profile's tunnel.
 */
export function isHandedToShell (url: string, headers: RequestHeaders): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const origin = parsed.origin
  if (relayHandlerFor(origin) === undefined) return false
  if (requestHeader(headers, OWN_READ_HEADER) === ownReadToken()) return false
  return isOwnSiteRequest(headers, parsed.hostname)
}

/** What the host is started with: the secret that marks a read of the shell's own, and the origins it hands to the shell. */
export function hostShell (): NonNullable<HostConfig['shell']> {
  return { ownReadToken: ownReadToken(), origins: relayableOrigins() }
}

/** Tells the host the whole set it is to hand to the shell: at the host's report that it listens too, before the held requests are let go, so an origin served since its configuration was built is in its set. */
export function announceServed (host: { send: (message: ShellServes) => unknown }): void {
  if (servedAnnouncementHeld()) return
  host.send({ type: 'shell-serves', origins: relayableOrigins() })
}

/** Answers the host's relayed requests with the handlers the shell serves from, and tells it of every change in what the shell serves. */
export function serveShell (host: { send: (message: ToHost) => boolean }): ShellResponder {
  onServingChange(() => { announceServed(host) })
  exposeServedHold(() => { announceServed(host) })
  return new ShellResponder({ send: (message) => host.send(message), handlerFor: relayHandlerFor })
}
