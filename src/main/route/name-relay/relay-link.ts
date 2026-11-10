// What the route controller takes of the name relay, and nothing else: the config that sessions following the system are
// set to while the relay is active, and the credentials its own listener's proxy challenge is answered with. Types only.

import type { RouteChallengeSource } from '../lookup-session.js'
import type { SystemProxyConfig } from '../system-follow.js'

export interface NameRelayLink {
  /** What a session that follows the system is set to while the relay is active; undefined while it is not, and the mirror's config applies. */
  readonly config: () => SystemProxyConfig | undefined
  /** What a proxy challenge from the relay's listener is answered with; undefined for a challenge from anything else. */
  readonly credentials: RouteChallengeSource
}
