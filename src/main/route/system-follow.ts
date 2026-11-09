// What a session that follows the system is set to, and which sessions took it last. The route controller supplies the facts
// that decide whether a session may be touched and runs each set in the session's turn. The config is `{ mode: 'system' }`,
// which a session has when it is made and so is never set again, until a mirror of the system's settings supplies another.
// Pure over the calls it is handed: no `electron` value.

import type { Session } from 'electron'

/** What `setProxy` takes: Electron's own shape. */
export type SystemProxyConfig = Parameters<Session['setProxy']>[0]

const PLAIN_SYSTEM = JSON.stringify({ mode: 'system' })

export interface SystemFollowDeps<S extends object> {
  /** The config a session that follows the system gets, answered from memory. `{ mode: 'system' }` when left out. */
  readonly config?: (() => SystemProxyConfig) | undefined
  /** Sets `session` to `config`, tracked and bounded; rejects when the call fails or takes too long. */
  readonly set: (session: S, config: SystemProxyConfig) => Promise<void>
  /** Whether `session` is not to be set to the system's config now: on a front, stopped, in a tunnel of its own, or setting a proxy of its own. Read inside the session's turn. */
  readonly kept: (session: S) => boolean
  /** Runs `work` once the changes already under way to `session` are done. */
  readonly inTurn: (session: S, work: () => Promise<void>) => Promise<void>
}

export interface SystemFollow<S extends object> {
  /** Sets `session` to the config now, inside its turn: for a session that is leaving a front or the dead end. */
  put: (session: S) => Promise<void>
  /** `session` was just created and follows the system: it is set to the config one microtask on, once its maker has marked it as one that sets a proxy of its own. */
  adopted: (session: S) => void
  /** The config changed: `sessions` and every mirrored session are set to it where they are not kept. Resolves when every set ended; a failed one is logged and tried again by the next call. */
  changed: (sessions: Iterable<S>) => Promise<void>
  /** `session` takes the config whatever else was done to it, now and at every `changed`. Rejects when the first set fails. */
  mirror: (session: S) => Promise<void>
}

export function createSystemFollow<S extends object> (deps: SystemFollowDeps<S>): SystemFollow<S> {
  /** The config each session took last, as JSON. */
  const took = new WeakMap<S, string>()
  const mirrored = new Set<S>()
  const current = (): SystemProxyConfig => deps.config?.() ?? { mode: 'system' }

  async function put (session: S): Promise<void> {
    const config = current()
    await deps.set(session, config)
    took.set(session, JSON.stringify(config))
  }

  async function follow (session: S): Promise<void> {
    const own = mirrored.has(session)
    if (!own && deps.kept(session)) return
    // A session that was never set is on the system's own config.
    if ((took.get(session) ?? (own ? undefined : PLAIN_SYSTEM)) === JSON.stringify(current())) return
    await put(session)
  }

  async function followInTurn (session: S): Promise<void> {
    try {
      await deps.inTurn(session, async () => { await follow(session) })
    } catch (error) {
      console.error('[route] could not set a session to the system\'s config:', error)
    }
  }

  return {
    put,
    adopted: (session) => {
      queueMicrotask(() => {
        void followInTurn(session) // orivon:floating-ok -- followInTurn catches everything it awaits
      })
    },
    changed: async (sessions) => { await Promise.all([...new Set([...mirrored, ...sessions])].map(followInTurn)) },
    mirror: async (session) => {
      mirrored.add(session)
      await deps.inTurn(session, async () => { await put(session) })
    }
  }
}
