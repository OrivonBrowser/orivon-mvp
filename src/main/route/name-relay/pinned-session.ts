// The session a caller in main reads through a pinned endpoint: in memory, set to the endpoint's config, and left alone by the
// shared tunnel identity. One per endpoint, so an endpoint that was started again (on a new port) is pointed at afresh.
// Tied to Electron through the session it is handed.

import type { Session } from 'electron'
import { markOwnProxy } from '../own-proxy.js'
import type { PinnedEndpoint } from './pinned-endpoint.js'
import { quietSession } from './quiet-session.js'
import type { QuietableSession } from './quiet-session.js'

/** No `persist:` prefix: nothing a pinned read does is kept. */
export const PINNED_PARTITION = 'orivon-name-pinned'

const made = new WeakMap<PinnedEndpoint, Promise<object>>()

/** The session for `endpoint`, made by `makeSession` once and set to the endpoint's config before it is returned. A session that could not be set is made again by the next caller. */
export async function sessionThrough<S extends Pick<Session, 'setProxy'> & QuietableSession> (endpoint: PinnedEndpoint, makeSession: (partition: string) => S): Promise<S> {
  let ready = made.get(endpoint) as Promise<S> | undefined
  if (ready === undefined) {
    const session = quietSession(makeSession(PINNED_PARTITION))
    markOwnProxy(session)
    const setting = session.setProxy(endpoint.config).then(() => session)
    ready = setting
    made.set(endpoint, setting)
    setting.catch(() => { if (made.get(endpoint) === setting) made.delete(endpoint) })
  }
  return await ready
}
