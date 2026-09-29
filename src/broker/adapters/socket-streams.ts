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
        // A COPY, not a view over `chunk`'s own backing buffer. Node
        // allocates each socket read at exactly its size today (measured:
        // `chunk.buffer.byteLength === chunk.byteLength` at offset 0), which
        // is what makes a zero-copy view safe -- but it is an unspecified
        // Node detail, not a documented guarantee, and a future pooled or
        // shared read buffer would ship neighbouring bytes to the renderer:
        // `MessagePortMain` structured-clones the WHOLE backing `ArrayBuffer`
        // a chunk points into, not just the view's own bytes. `new
        // Uint8Array(chunk)` copies chunk's elements into a fresh buffer,
        // matching what `Duplex.toWeb` did.
        controller.enqueue(new Uint8Array(chunk))
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
      // Reachable with `settled` still false only when something OUTSIDE
      // this stream destroys the socket directly, with no error, before
      // 'end' or 'error' ever fired: cancel() above already sets `settled`
      // first, so this is never that path. The one real caller is
      // ../node-adapters.ts's `destroySocket`'s drain-deadline timeout (a
      // peer that stops draining our writable) -- and that path is a
      // graceful, app-initiated close for which `destroySocket` itself
      // always resolves. Reporting THIS side as a clean end matches that:
      // ../transport/relay/socket.ts's pump would otherwise turn an
      // already-successful close into a spurious 'internal' read failure
      // (Node's own old `Duplex.toWeb` errored the readable with an
      // AbortError here instead; this adapter deliberately does not copy
      // that -- see socket-streams.test.ts's own case for this).
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
      // Resolves like `Duplex.toWeb` did: once the kernel accepts this chunk
      // (`socket.write` returns `true`), or -- past `writableHighWaterMark`
      // -- once `'drain'` fires, never on the write's own flush callback.
      // Waiting for that callback let only one chunk be in flight at a time;
      // this lets writes pipeline the way a real Writable's backpressure
      // does. A write error still rejects, through the same callback, as
      // long as this one has not already resolved -- once resolved, a later
      // failure surfaces on `controller.error` (the listener above) rather
      // than retracting an already-settled write, the same as any other
      // WHATWG stream.
      return new Promise<void>((resolve, reject) => {
        let writeSettled = false
        const onError = (error: Error): void => {
          if (writeSettled) return
          writeSettled = true
          socket.off('drain', onDrain)
          reject(error)
        }
        const onDrain = (): void => {
          if (writeSettled) return
          writeSettled = true
          resolve()
        }
        const acceptedByKernel = socket.write(chunk, (error) => { if (error != null) onError(error) })
        if (acceptedByKernel) {
          writeSettled = true
          resolve()
        } else {
          socket.once('drain', onDrain)
        }
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
