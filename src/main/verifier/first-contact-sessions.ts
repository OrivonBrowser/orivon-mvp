// The sessions' first-contact gates (first-contact.ts): one per session that reaches the verifier, since
// Chromium keeps TLS sessions per session. Tied to Electron through the session's web request owner.

import type { Session } from 'electron'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { FirstContact } from './first-contact.js'
import { targetsVerifiedHost, verifiedHostFilter } from './partition-stamp.js'

/** The longest the other requests to a host wait for the first one's connection: a handshake takes milliseconds, so this only bounds a first request that never connects. */
const WAIT_MS = 3_000
/** How long after the first connection to a host the next ones are taken to resume its TLS session (the verifier's sessions last 300 s). */
const WARM_MS = 120_000
/** From the certificate being accepted to the TLS session being kept: the server sends its ticket right after the handshake, so this is loopback round trips, not a guess at the network. */
const SESSION_KEPT_MS = 50

const contacts = new Map<Session, FirstContact>()

/** Registers the gate's events on `target`; the returned function holds a request (by its url and id) until it may go on. */
export function installFirstContact (target: Session): (url: string, id: number) => Promise<void> {
  const contact = new FirstContact({ waitMs: WAIT_MS, warmMs: WARM_MS })
  contacts.set(target, contact)
  const owner = webRequestOwnerFor(target)
  const hostOf = (url: string): string => new URL(url).hostname
  owner.onResponseStarted(verifiedHostFilter(), targetsVerifiedHost, (details) => { contact.reached(hostOf(details.url)) })
  owner.onCompleted(verifiedHostFilter(), targetsVerifiedHost, (details) => { contact.ended(hostOf(details.url), details.id) })
  owner.onErrorOccurred(verifiedHostFilter(), targetsVerifiedHost, (details) => { contact.ended(hostOf(details.url), details.id) })
  return async (url, id) => { await contact.enter(hostOf(url), id) }
}

/** A connection to `host` in `target` had its certificate accepted: once its session ticket has had time to arrive, the host's other connections may begin. */
export function noteAcceptedConnection (target: Session, host: string): void {
  setTimeout(() => { contacts.get(target)?.reached(host) }, SESSION_KEPT_MS)
}

/** A new host process has a new certificate and no TLS sessions: every host is a first contact again. */
export function resetFirstContacts (): void {
  for (const contact of contacts.values()) contact.reset()
}
