// The shell's half of a request the verifier host relays for a host the shell serves from a copy it keeps: it builds a
// `Request` from what the host read off the socket, answers it with the handler that host's partition uses, and streams
// the `Response` back a window at a time. A pure decision over two callbacks; verifier-subsystem.ts gives it the
// parent port and the registry of handlers.

import { MAX_RELAYS, RELAY_CHUNK_BYTES, RELAY_WINDOW_BYTES } from '../../protocols/verifier-host/protocol.js'
import type { RelayFromHost, RelayRequest, RelayToHost } from '../../protocols/verifier-host/protocol.js'
import type { AppRequestHandler } from '../../loader/serve/serve.js'

export interface ShellResponderDeps {
  /** Posts to the host; false when none runs. */
  readonly send: (message: RelayToHost) => boolean
  /** The handler that answers for `origin`, or undefined when the shell serves nothing there now. */
  readonly handlerFor: (origin: string) => AppRequestHandler | undefined
}

/** A request being answered. */
interface Answering {
  readonly abort: AbortController
  /** Bytes sent that the host has not yet said it wrote. */
  outstanding: number
  /** Resolves the wait for the host to write; set only while the stream waits. */
  wake: (() => void) | undefined
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined
}

const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function plain (status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/** `chunk` in pieces of at most `RELAY_CHUNK_BYTES`, each in a buffer of its own: a view would be cloned with the whole buffer behind it. */
function* piecesOf (chunk: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < chunk.byteLength; at += RELAY_CHUNK_BYTES) {
    const end = Math.min(at + RELAY_CHUNK_BYTES, chunk.byteLength)
    const piece = new Uint8Array(end - at)
    piece.set(chunk.subarray(at, end))
    yield piece
  }
}

export class ShellResponder {
  private readonly answering = new Map<number, Answering>()

  constructor (private readonly deps: ShellResponderDeps) {}

  receive (message: RelayFromHost): void {
    switch (message.type) {
      case 'relay-request': this.answer(message).catch((error: unknown) => { console.error('[verifier] answering a relayed request failed:', error) }); break
      case 'relay-wrote': {
        const state = this.answering.get(message.id)
        if (state === undefined) break
        state.outstanding = Math.max(0, state.outstanding - message.bytes)
        state.wake?.()
        break
      }
      case 'relay-abort': this.stop(message.id); break
    }
  }

  /** The host is gone or asleep: nothing is waiting for any answer. */
  abortAll (): void {
    for (const id of [...this.answering.keys()]) this.stop(id)
  }

  private stop (id: number): void {
    const state = this.answering.get(id)
    if (state === undefined) return
    state.abort.abort()
    state.wake?.()
    // A handler's body may never end on its own: cancelling it is what lets the read waiting on it return.
    void state.reader?.cancel().catch(() => {})
  }

  private async answer (message: RelayRequest): Promise<void> {
    const { id } = message
    if (this.answering.has(id)) return
    if (this.answering.size >= MAX_RELAYS) {
      this.deps.send({ type: 'relay-error', id, message: 'the shell is answering too many relayed requests' })
      return
    }
    const state: Answering = { abort: new AbortController(), outstanding: 0, wake: undefined, reader: undefined }
    this.answering.set(id, state)
    try {
      const response = await this.responseTo(message, state.abort.signal)
      if (state.abort.signal.aborted) {
        void response.body?.cancel().catch(() => {})
        return
      }
      await this.stream(id, state, response)
    } catch (error) {
      if (!state.abort.signal.aborted) this.deps.send({ type: 'relay-error', id, message: error instanceof Error ? error.message : String(error) })
    } finally {
      this.answering.delete(id)
    }
  }

  private async responseTo (message: RelayRequest, signal: AbortSignal): Promise<Response> {
    let url: URL
    try {
      url = new URL(message.url)
    } catch {
      return plain(400, 'Orivon: not an address')
    }
    // The origin of the address is what picks the handler, so the handler only ever sees a request for the app it answers for.
    const handler = url.protocol === 'https:' ? this.deps.handlerFor(url.origin) : undefined
    if (handler === undefined) return plain(404, 'Orivon: this app was stopped')
    if (!METHOD.test(message.method)) return plain(400, 'Orivon: not a method')
    const headers = new Headers()
    for (const [name, value] of message.headers) {
      try {
        headers.append(name, value)
      } catch {
        // A header the runtime refuses is left out; the handler reads what it understands.
      }
    }
    let request: Request
    try {
      request = new Request(url, { method: message.method, headers, signal })
    } catch {
      return plain(405, 'Orivon: this request cannot be answered here')
    }
    return await handler(request)
  }

  private async stream (id: number, state: Answering, response: Response): Promise<void> {
    // A handler that ends a request with a network error (`Response.error()`) means the load fails, not that a page was found.
    if (response.type === 'error' || response.status < 200 || response.status > 599) {
      this.deps.send({ type: 'relay-error', id, message: 'the handler ended the request with a network error' })
      return
    }
    if (!this.deps.send({ type: 'relay-head', id, status: response.status, headers: [...response.headers] })) return
    const reader = response.body?.getReader()
    if (reader === undefined) {
      this.deps.send({ type: 'relay-end', id })
      return
    }
    state.reader = reader
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        if (!(next.value instanceof Uint8Array)) throw new Error('the handler\'s body held something that is not bytes')
        for (const piece of piecesOf(next.value)) {
          if (!await this.credit(state, piece.byteLength)) return
          state.outstanding += piece.byteLength
          if (!this.deps.send({ type: 'relay-body', id, chunk: piece })) return
        }
        if (state.abort.signal.aborted) return
      }
      if (!state.abort.signal.aborted) this.deps.send({ type: 'relay-end', id })
    } finally {
      await reader.cancel().catch(() => {})
    }
  }

  /** Waits until `bytes` more may be sent: the host has written enough of what it holds, or holds nothing. False once the request was stopped. */
  private async credit (state: Answering, bytes: number): Promise<boolean> {
    while (!state.abort.signal.aborted && state.outstanding > 0 && state.outstanding + bytes > RELAY_WINDOW_BYTES) {
      await new Promise<void>((resolve) => { state.wake = resolve })
      state.wake = undefined
    }
    return !state.abort.signal.aborted
  }
}
