// What main answers when a utility process forked on a pinned endpoint's session meets the endpoint's proxy challenge. The child
// is forked with `respondToAuthRequestsFromMainProcess: true`, so the challenge is raised here and the secret never enters the
// child. Pure over the child and the credentials it is handed: no `electron` value.

import type { RouteChallengeSource } from '../lookup-session.js'

/** The part of a `UtilityProcess` this needs. Its `login` listener is typed with three parameters. */
export interface LoginEmitter {
  on: (event: 'login', listener: (...args: unknown[]) => void) => unknown
}

function isAuthInfo (value: unknown): value is Parameters<RouteChallengeSource>[0] {
  if (typeof value !== 'object' || value === null) return false
  const info = value as Record<string, unknown>
  return typeof info['isProxy'] === 'boolean' && typeof info['host'] === 'string' && typeof info['port'] === 'number'
}

/**
 * Signs `child` in where `source` answers (the pinned endpoints' port), and cancels every other challenge. At run time the listener
 * receives four arguments, an event first, where the typings list three: the details, the challenge and the callback are read by
 * position from the second. A call of any other shape is cancelled through its last argument, never answered.
 */
export function answerUtilityChallenges (child: LoginEmitter, source: RouteChallengeSource): void {
  child.on('login', (...args) => {
    const last = args.at(-1)
    if (typeof last !== 'function') return
    const callback = last as (username?: string, password?: string) => void
    const info = args[2]
    const answer = args.length === 4 && isAuthInfo(info) ? source(info) : undefined
    if (answer === undefined) callback()
    else callback(answer.username, answer.password)
  })
}
