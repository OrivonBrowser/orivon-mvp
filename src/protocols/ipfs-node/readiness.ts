// The node is ready once `GET /health` answers: it needs no peers counted,
// because it looks content up on demand rather than holding a peer set open.

import type { Readiness, ReadinessDeps } from '../local-node/kind.js'

const ANSWER_MS = 3_000

/** Posts `listening` and `ready` together, once, when the health endpoint first answers. */
export function watchReadiness (deps: ReadinessDeps): Readiness {
  let stopped = false
  let polling = false
  let done = false
  const poll = async (): Promise<void> => {
    let answered = false
    try {
      answered = (await deps.fetcher(`${deps.base}/health`, AbortSignal.timeout(ANSWER_MS))).ok
    } catch {
      // Not listening yet: the next poll.
    }
    if (stopped || done || !answered) return
    done = true
    deps.post({ type: 'listening' })
    deps.post({ type: 'ready', peers: 0 })
    clearInterval(timer)
  }
  const timer = setInterval(() => {
    if (polling) return
    polling = true
    void poll().finally(() => { polling = false })
  }, deps.everyMs)
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
