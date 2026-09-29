// Wraps a real net.Socket in WHATWG streams for ./node-adapters.ts's
// dialOne/wrapAccepted, split out under code-guidelines.md Rule 2 once this
// pushed that file past 500 lines. NOT a generic Duplex-to-web adapter: it
// only ever sees a connected TCP (or TLS) socket carrying bytes, never an
// object-mode or half-constructed stream, so it does not have to handle
// everything node:stream.Duplex.toWeb does. See README.md's Design notes
// for why it exists at all instead of just calling that.

import type { Socket } from 'node:net'

/**
 * The `code` a `write()` rejects with when the app writes after the peer's
 * FIN already ended this socket's writable side on its own (`allowHalfOpen:
 * false`, docs/open-questions.md A69). `../transport/relay/port-sink.ts`'s
 * `isWritableAlreadyEnded` checks for exactly this, rather than sniffing an
 * error's `name`/`code` for a shape a Node internal happened to produce --
 * see README.md's Design notes.
 */
export const WRITABLE_ALREADY_ENDED_CODE = 'ORIVON_WRITABLE_ALREADY_ENDED'

/**
 * A hand-written substitute for `Duplex.toWeb(socket).readable`. See
 * README.md's Design notes for why: `node:internal/webstreams/adapters.js`'s
 * own `finished()`-driven bookkeeping has a confirmed, currently-unfixed
 * Node engine bug (nodejs/node#63761) that can throw a bare `TypeError`
 * (`Cannot read properties of undefined (reading 'error')`) out of a
 * socket's own async teardown, with nowhere for a caller to catch it --
 * taking the whole Electron main process down through index.ts's
 * uncaughtException policy. This version tracks one local `settled` flag
 * per stream instead of threading Node's internal per-direction
 * destroy-state through `finished()`'s own bookkeeping, so a racing
 * `reader.cancel()`, a real socket error and the handle table's own
 * `destroySocket` call can never reach a second `controller.close()`/
 * `controller.error()` call: `settled` makes the second one a plain no-op,
 * never a second attempt to read a field off a reference nothing nulls.
 */
export function socketReadable (socket: Socket): ReadableStream<Uint8Array> {
  let settled = false

  return new ReadableStream<Uint8Array>({
    start (controller) {
      const onData = (chunk: Buffer): void => {
        if (settled) return
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        if (controller.desiredSize !== null && controller.desiredSize <= 0) socket.pause()
      }
      const onEnd = (): void => {
        if (settled) return
        settled = true
        controller.close()
      }
      const onError = (error: Error): void => {
        if (settled) return
        settled = true
        controller.error(error)
      }
      const onClose = (): void => {
        if (settled) return
        settled = true
        controller.close()
      }
      socket.pause()
      socket.on('data', onData)
      socket.once('end', onEnd)
      socket.once('error', onError)
      socket.once('close', onClose)
    },
    pull () { socket.resume() },
    // Matches Duplex.toWeb's own cancel(): destroys the WHOLE socket, not
    // only the read direction -- ../transport/relay/socket.ts's onUnlink
    // depends on that (its own "THE BRANCH IS LOAD-BEARING" comment).
    cancel (reason) {
      settled = true
      socket.destroy(reason instanceof Error ? reason : undefined)
    }
  }, new ByteLengthQueuingStrategy({ highWaterMark: socket.readableHighWaterMark }))
}

/**
 * A hand-written substitute for `Duplex.toWeb(socket).writable`. Same
 * README.md pointer and the same `settled`-flag shape as `socketReadable`
 * above. `write()` checks `socket.writable` itself, up front, rather than
 * inferring the A69 half-close case from an error's shape after the fact.
 */
export function socketWritable (socket: Socket): WritableStream<Uint8Array> {
  let settled = false
  let controller: WritableStreamDefaultController

  // Only 'error': an ordinary close carries nothing for the writer to be
  // told that its own close()/abort() promises do not already settle --
  // unlike Duplex.toWeb's adapter, this one does not synthesize an
  // AbortError for a peer-driven close (see the WRITABLE_ALREADY_ENDED_CODE
  // doc above for where that case is actually handled).
  socket.once('error', (error: Error) => {
    if (settled) return
    settled = true
    controller.error(error)
  })

  return new WritableStream<Uint8Array>({
    start (c) { controller = c },
    write (chunk) {
      if (!socket.writable) {
        return Promise.reject(Object.assign(new Error('the writable already ended'), { code: WRITABLE_ALREADY_ENDED_CODE }))
      }
      return new Promise<void>((resolve, reject) => {
        socket.write(chunk, (error) => { if (error != null) reject(error); else resolve() })
      })
    },
    close () {
      return new Promise<void>((resolve, reject) => {
        socket.end((error?: Error) => { if (error != null) reject(error); else resolve() })
      })
    },
    // Matches Duplex.toWeb's own abort(): destroys the socket (an RST via
    // ../node-adapters.ts's own destroySocket, called separately by the
    // handle table -- this is the WEB STREAM's own abort, kept for API
    // completeness; ../transport/relay/port-sink.ts's stop() deliberately
    // never calls it once the real teardown has already happened).
    abort (reason) {
      settled = true
      socket.destroy(reason instanceof Error ? reason : undefined)
    }
  }, { highWaterMark: socket.writableHighWaterMark })
}
