// A199/A200 (docs/open-questions.md): guards a third-party reach response's
// already-streaming body against two things `fetchThirdParty`'s own
// one-shot check (serve.ts) cannot catch by itself -- a grant revoked while
// the body is still in flight, and a request that never releases the
// socket-allowance slot it reserved. Split out of serve.ts
// (code-guidelines.md Rule 2 -- a distinct concern, the same seam
// serve/range.ts/serve-content-type.ts/serve-verify.ts already use).
//
// See src/loader/README.md's Design notes ("Why A199's cancellation hooks
// in the handler, not the dial or the grant ledger's own cascade") for the
// full reasoning behind polling `authoriseReach` here rather than the two
// alternatives.

import type { ConnectSecureDecision } from '../../broker/policy/connect-secure.js'

/**
 * How often a still-streaming third-party response re-checks its own
 * authorisation (A199). Exported so a test can shrink it rather than
 * waiting on the production interval.
 */
export const REACH_REVOCATION_POLL_MS = 200

/**
 * A200: reserves one of this origin's socket-allowance slots for a reach
 * request about to start. `true` (possibly after a bounded wait in a FIFO
 * queue, reach/slots.ts) means the slot is held; `false` means none
 * came free in time, and the caller refuses the request. `signal` lets a
 * cancelled request leave the queue.
 *
 * A free slot MUST be checked-and-reserved as one synchronous step, the
 * discipline `GrantLedger.reserveFsBytes`'s own doc names: two reach
 * requests racing this function must not both read the same
 * pre-reservation count and both pass.
 */
export type ReserveReachSlot = (signal?: AbortSignal) => boolean | Promise<boolean>

/**
 * Releases a slot `ReserveReachSlot` reserved. `guardReachResponse` below
 * calls this at most once per reservation, on every path the request can
 * end -- but an implementation must still be safe to call more than once
 * across its own lifetime (one release per matching reserve), the same
 * idempotence-under-mismatch `GrantLedger.releaseFsBytes` already commits to.
 */
export type ReleaseReachSlot = () => void

/**
 * Wraps `response`'s body so a grant revoked WHILE its bytes are still
 * streaming actually stops them, rather than only ever refusing the NEXT
 * request -- `fetchThirdParty` already does that half by calling
 * `authoriseReach` once, before dialling.
 *
 * `release` runs EXACTLY ONCE, on every path the stream can end: a clean
 * EOF, an upstream read error, the consumer cancelling its own read
 * (navigation, an aborted fetch), and a revoke caught by the poll below --
 * A200's own requirement that a reserved slot is never leaked.
 *
 * WHAT THE READING PAGE OBSERVES ON A REVOKE: not a truncated-but-otherwise
 * -normal body. `controller.error` on the wrapped stream is what a page's
 * own `fetch()` surfaces as a rejected read -- a real failure, never a byte
 * count it could mistake for "that was the whole file".
 */
export function guardReachResponse (
  response: Response,
  host: string,
  port: number,
  authoriseReach: (host: string, port: number) => Promise<ConnectSecureDecision>,
  release: () => void
): Response {
  const body = response.body
  if (body === null) {
    // Nothing streams and nothing could go stale later -- HEAD, 204, ....
    release()
    return response
  }

  const reader = body.getReader()
  let timer: ReturnType<typeof setInterval> | undefined
  let finished = false

  function finish (): void {
    if (finished) return
    finished = true
    if (timer !== undefined) clearInterval(timer)
    release()
  }

  function revoke (controller: ReadableStreamDefaultController<Uint8Array>, message: string): void {
    if (finished) return
    finish()
    void reader.cancel(message).catch(() => {})
    controller.error(new Error(`orivon: ${message}`))
  }

  const guarded = new ReadableStream<Uint8Array>({
    start (controller) {
      timer = setInterval(() => {
        authoriseReach(host, port)
          .then((decision) => {
            if (!decision.allowed) revoke(controller, 'the grant authorising this reach was revoked')
          })
          // A broker fault mid-poll must fail closed, the same as a real
          // revoke -- never let the app keep reading past a check that
          // could not even run.
          .catch(() => { revoke(controller, "could not re-verify this reach's authorisation") })
      }, REACH_REVOCATION_POLL_MS)
      // Must not itself keep the main process alive -- same "unref this
      // background timer" rule datagram-pump.ts's own dropTimer already
      // follows. A page that creates a reach fetch() and never reads or
      // cancels its body must not be why Electron cannot exit.
      timer.unref?.()
    },
    async pull (controller) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (error) {
        if (finished) return // the poll above already errored this stream
        finish()
        controller.error(error)
        return
      }
      if (finished) return // the poll fired while this read was in flight
      if (result.done) {
        finish()
        controller.close()
        return
      }
      controller.enqueue(result.value)
    },
    cancel (reason) {
      finish()
      return reader.cancel(reason)
    }
  })

  return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers })
}
