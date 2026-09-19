// The `CONTROL_CHANNEL` request/timeout machinery every `orivon.*` method
// needs, net and non-net alike -- split out of ./orivon-surface.ts under
// code-guidelines.md Rule 2 so ./net-surface.ts can share it without an
// import cycle back through ./orivon-surface.ts. See ./README.md's Design
// notes for the rest of this split.

import { ipcRenderer } from 'electron'
import { CONTROL_CHANNEL } from '../main/channels.js'
import { LIMITS } from '../contracts/index.js'
import type { RequestEnvelope, ResponseEnvelope } from '../contracts/ipc.js'
import { toOrivonError } from './orivon-error.js'

/** Every call through `call()` below carries an explicit timeout (../contracts/ipc.ts's rule 2) -- this is where each capability's own budget is picked. */
export const TIMEOUT_MS = {
  /** app.manifest / app.grants: broker-local reads, no I/O of their own. */
  metadata: 5_000,
  /** fs.readFile / fs.writeFile: disk I/O, generous for a large file. */
  fs: 15_000,
  /** id.publicKey / id.sign: WebCrypto plus a keychain read, no network I/O -- metadata's own budget covers it with room to spare. */
  id: 5_000,
  /**
   * net.connect / net.close / net.setNoDelay / net.setKeepAlive. Must
   * exceed node-adapters.ts's own DIAL_TIMEOUT_MS (30_000) -- otherwise a
   * legitimately slow dial reports THIS timeout instead of the broker's
   * real 'timeout' answer, discarding the more specific error for a less
   * useful one.
   */
  net: 35_000,
  /**
   * app.requestGrant: a native dialog awaiting a human decision, not I/O --
   * no natural bound exists, but contracts/ipc.ts's rule 2 requires one
   * anyway. Generous rather than tuned: `withTimeout` (../broker/transport/
   * ipc.ts) never cancels the underlying prompt when this fires, so a
   * person who takes longer than this still gets their grant, just not
   * this call's own resolved value -- see that function's own doc. AI
   * recommendation, not an owner decision -- open-questions.md A140.
   */
  grant: 120_000,
  /** web.openContext (ADR-0019): opens a real WebContentsView and loads a data: URL at the requested origin -- no LIMITS constant bounds this explicitly, so a generous, net.connect-shaped budget is used instead. */
  webOpen: 35_000,
  /** web.evaluate -- MUST EXCEED LIMITS.webContextEvaluateMs, the broker's own real 'timeout', for the same reason `net`'s own budget must exceed node-adapters.ts's DIAL_TIMEOUT_MS: otherwise this transport-level fallback fires first and discards the broker's more specific answer. */
  webEvaluate: LIMITS.webContextEvaluateMs + 5_000,
  /** web.close -- a plain teardown, no I/O of its own beyond closing the host's view. */
  webClose: 10_000,
  /**
   * web.awaitClose -- ./web-surface.ts's own long-poll loop (see that
   * file's header): each iteration waits this long for the context to
   * actually close before the loop reissues the call, so a context that
   * simply never closes costs one request roughly every LIMITS.
   * webContextIdleMs, not an unbounded pending IPC call. Set just past the
   * idle timer itself so an idle-close is normally caught on the FIRST
   * iteration rather than always looping once.
   */
  webAwaitClose: LIMITS.webContextIdleMs + 5_000
} as const

/**
 * Settles with a synthetic failure ResponseEnvelope -- 'timeout' if `promise`
 * has not settled within `timeoutMs`, 'internal' if it rejects outright --
 * rather than ever rejecting itself. That gives `call()` below exactly one
 * place that turns a failure envelope into a thrown OrivonError, regardless
 * of which of the three ways (broker failure response, our own timeout, a
 * raw rejection) the underlying call failed. A raw rejection is possible
 * here (Electron's own internal string, a serialisation refusal) and must
 * never reach the page unwrapped -- contracts/errors.ts requires every
 * rejection an app sees to be OrivonError-shaped so an exhaustive
 * `switch (e.code)` works.
 */
async function raceTimeout<T> (promise: Promise<ResponseEnvelope<T>>, timeoutMs: number): Promise<ResponseEnvelope<T>> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ id: '', ok: false, code: 'timeout', message: `control call exceeded its ${timeoutMs}ms budget` })
    }, timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => {
        clearTimeout(timer)
        // The isolated world's OWN console -- contextIsolation means the
        // page cannot see or intercept this call. See ./README.md's design
        // notes for why the underlying error can never just be re-thrown.
        console.error('[orivon] control call failed', error)
        resolve({ id: '', ok: false, code: 'internal', message: 'control call failed' })
      }
    )
  })
}

// A plain counter, not crypto.randomUUID(): the id only has to correlate a
// reply within this process's own ipcRenderer.invoke() call (which already
// does that matching itself), never anything security-relevant -- and
// randomUUID() is gated to secure contexts, which a plain http:// origin on
// a non-loopback host is not (ORIGIN_BEARING_SCHEMES, ../broker/policy/
// origin.js, includes http:). That would turn every control call into a
// thrown TypeError instead of an OrivonError, on a path smoke's loopback
// fixtures cannot reach.
let nextRequestId = 0

/** One CONTROL_CHANNEL round trip: builds the envelope, races it against `timeoutMs`, and throws the real `OrivonError` on any failure shape. Every `orivon.*` method, here and in ./net-surface.ts alike, calls through here. */
export async function call<TResult> (method: string, payload: unknown, timeoutMs: number): Promise<TResult> {
  const envelope: RequestEnvelope<unknown> = { id: `r${++nextRequestId}`, method, payload, timeoutMs }
  const response = await raceTimeout(
    ipcRenderer.invoke(CONTROL_CHANNEL, envelope) as Promise<ResponseEnvelope<TResult>>,
    timeoutMs
  )
  if (response.ok) return response.result
  throw toOrivonError(response.code, response.platformCode === undefined
    ? { message: response.message }
    : { message: response.message, platformCode: response.platformCode })
}
