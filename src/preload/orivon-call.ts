import { ipcRenderer } from 'electron'
import { CONTROL_CHANNEL } from '../main/channels.js'
import type { RequestEnvelope, ResponseEnvelope } from '../contracts/ipc.js'
import { toOrivonError } from './orivon-error.js'

// The one control-channel call primitive every orivon.* bridge closure goes
// through -- split out of ./orivon-surface.ts under code-guidelines.md Rule 2
// (by concern: this is "how one request/reply round trip works", separate
// from "which closures exist and what they call", which ./orivon-surface.ts
// and ./orivon-net-bridge.ts still own).
//
// `call()` is the only thing that touches `ipcRenderer.invoke` (the raw
// MessagePortMain/ipcRenderer never crossing into the main world is the
// whole directory's rule, not just this file's). Every call through `call()`
// carries an explicit timeout (../contracts/ipc.ts's rule 2) -- see
// TIMEOUT_MS below.
export const TIMEOUT_MS = {
  /** app.manifest / app.grants: broker-local reads, no I/O of their own. */
  metadata: 5_000,
  /** fs.readFile / fs.writeFile: disk I/O, generous for a large file. */
  fs: 15_000,
  /** id.publicKey / id.sign: WebCrypto plus a keychain read, no network I/O -- metadata's own budget covers it with room to spare. */
  id: 5_000,
  /**
   * net.connect / net.connectSecure / net.listen / net.udpBind / net.close /
   * net.setNoDelay / net.setKeepAlive. Must exceed node-adapters.ts's own
   * DIAL_TIMEOUT_MS (30_000) -- otherwise a legitimately slow dial reports
   * THIS timeout instead of the broker's real 'timeout' answer, discarding
   * the more specific error for a less useful one.
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
  grant: 120_000
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
        // page cannot see or intercept this call. See ../README.md's design
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
