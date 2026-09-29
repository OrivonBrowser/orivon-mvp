// wasi:io: pollables, and the input and output streams every other
// interface hands out (stdio, files, sockets). A stream wraps a byte source
// or sink that is asynchronous underneath; the non-blocking calls answer
// from what has already arrived, and the blocking ones wait, which the
// component reaches through JSPI.

import { isTermination } from '../wasi/termination.js'

/** Which interface's `*-error-code` function names an error: each reports none for the other's. */
export type ErrorCode = { readonly kind: 'filesystem' | 'network', readonly code: string }

/** wasi:io/error's `error` resource. */
export class IoError {
  readonly #message: string
  readonly #code: ErrorCode | undefined

  constructor (message: string, code?: ErrorCode) {
    this.#message = message
    this.#code = code
  }

  /** The code filesystem-error-code or network-error-code reports, for its own kind only. */
  codeFor (kind: ErrorCode['kind']): string | undefined {
    return this.#code?.kind === kind ? this.#code.code : undefined
  }

  toDebugString (): string {
    return this.#message
  }
}

/** A stream error as the component sees it: the value a host function throws for `result<_, stream-error>`. */
export type StreamError = { readonly tag: 'closed' } | { readonly tag: 'last-operation-failed', readonly val: IoError }

export const CLOSED: StreamError = { tag: 'closed' }

/** `code` names the failure for filesystem-error-code or network-error-code. */
export function failed (error: unknown, code?: ErrorCode): StreamError {
  return { tag: 'last-operation-failed', val: new IoError(error instanceof Error ? error.message : String(error), code) }
}

/** What a stream throws once its source or sink failed: a termination stays one, so it unwinds the program. */
type Failure = StreamError | Error

function failure (error: unknown, codeOf: CodeOf | undefined): Failure {
  return isTermination(error) ? error : failed(error, codeOf?.(error))
}

/**
 * One wait shared by everyone until the next notify, so a program that polls
 * in a loop does not pile up waiters on something that never happens.
 */
export class Signal {
  #waiting: Promise<void> | undefined
  #wake: () => void = () => {}

  wait (): Promise<void> {
    this.#waiting ??= new Promise<void>((resolve) => { this.#wake = resolve })
    return this.#waiting
  }

  notify (): void {
    const wake = this.#wake
    this.#waiting = undefined
    wake()
  }
}

export class Pollable {
  readonly #isReady: () => boolean
  readonly #wait: () => Promise<void>

  /** `wait` settles once `isReady` would answer true. */
  constructor (isReady: () => boolean, wait: () => Promise<void>) {
    this.#isReady = isReady
    this.#wait = wait
  }

  ready (): boolean {
    return this.#isReady()
  }

  async block (): Promise<void> {
    while (!this.#isReady()) await this.#wait()
  }

  /** @internal Settles when the pollable may have become ready. */
  wait (): Promise<void> {
    return this.#wait()
  }
}

export const ALWAYS_READY = new Pollable(() => true, async () => {})

/** wasi:io/poll's `poll`: the indices of the pollables that are ready, waiting for at least one. */
export async function poll (list: readonly Pollable[]): Promise<Uint32Array> {
  if (list.length === 0) throw new TypeError('poll needs at least one pollable')
  for (;;) {
    const ready = list.flatMap((pollable, index) => pollable.ready() ? [index] : [])
    if (ready.length > 0) return new Uint32Array(ready)
    await Promise.race(list.map(async (pollable) => { await pollable.wait() }))
  }
}

/** Where an input stream's bytes come from. An empty array is the end of the stream. */
export type ByteSource = (max: number) => Promise<Uint8Array>

/** Names an underlying failure for the interface's error-code function, when it has one. */
export type CodeOf = (error: unknown) => ErrorCode | undefined

/** How many bytes one read of the source asks for. */
const SOURCE_CHUNK = 65_536

export class InputStream {
  readonly #source: ByteSource
  readonly #codeOf: CodeOf | undefined
  #buffered: Uint8Array = new Uint8Array(0)
  #ended = false
  #error: Failure | undefined
  #filling: Promise<void> | undefined

  constructor (source: ByteSource, codeOf?: CodeOf) {
    this.#source = source
    this.#codeOf = codeOf
  }

  /** Takes up to `len` bytes that have already arrived; none yet is an empty array, not an error. */
  read (len: bigint): Uint8Array {
    if (this.#buffered.length > 0) return this.#take(len)
    if (this.#error !== undefined) throw this.#error
    if (this.#ended) throw CLOSED
    void this.#fill()
    return new Uint8Array(0)
  }

  async blockingRead (len: bigint): Promise<Uint8Array> {
    while (this.#buffered.length === 0 && !this.#ended && this.#error === undefined) await this.#fill()
    return this.read(len)
  }

  skip (len: bigint): bigint {
    return BigInt(this.read(len).length)
  }

  async blockingSkip (len: bigint): Promise<bigint> {
    return BigInt((await this.blockingRead(len)).length)
  }

  subscribe (): Pollable {
    return new Pollable(() => this.#buffered.length > 0 || this.#ended || this.#error !== undefined, async () => { await this.#fill() })
  }

  /** A shutdown of the receiving side: what was buffered is discarded, and the stream reads closed. */
  discard (): void {
    this.#buffered = new Uint8Array(0)
    this.#ended = true
  }

  #take (len: bigint): Uint8Array {
    const count = Number(len < BigInt(this.#buffered.length) ? len : BigInt(this.#buffered.length))
    const taken = this.#buffered.subarray(0, count)
    this.#buffered = this.#buffered.subarray(count)
    return taken
  }

  /** One read of the source at a time; each caller waits on the one in flight. */
  async #fill (): Promise<void> {
    if (this.#buffered.length > 0 || this.#ended || this.#error !== undefined) return
    this.#filling ??= this.#source(SOURCE_CHUNK).then(
      (chunk) => {
        if (chunk.length === 0) this.#ended = true
        else this.#buffered = chunk
      },
      (error: unknown) => { this.#error = failure(error, this.#codeOf) }
    ).finally(() => { this.#filling = undefined })
    await this.#filling
  }
}

/** Where an output stream's bytes go; settles once they are taken. */
export type ByteSink = (bytes: Uint8Array) => Promise<void>

/** What `check-write` permits while nothing is in flight. */
const WRITE_BUDGET = 65_536n

export class OutputStream {
  readonly #sink: ByteSink
  readonly #codeOf: CodeOf | undefined
  #inFlight: Promise<void> | undefined
  #error: Failure | undefined

  constructor (sink: ByteSink, codeOf?: CodeOf) {
    this.#sink = sink
    this.#codeOf = codeOf
  }

  checkWrite (): bigint {
    if (this.#error !== undefined) throw this.#error
    return this.#inFlight === undefined ? WRITE_BUDGET : 0n
  }

  /** Starts the write; `check-write` answers zero until the sink has taken it. */
  write (contents: Uint8Array): void {
    if (this.#error !== undefined) throw this.#error
    if (contents.length === 0) return
    if (this.#inFlight !== undefined || BigInt(contents.length) > WRITE_BUDGET) throw new TypeError('a write exceeded what check-write permitted')
    const copy = contents.slice()
    this.#inFlight = this.#sink(copy).then(
      () => { this.#inFlight = undefined },
      (error: unknown) => { this.#inFlight = undefined; this.#error = failure(error, this.#codeOf) }
    )
  }

  async blockingWriteAndFlush (contents: Uint8Array): Promise<void> {
    await this.blockingFlush()
    for (let offset = 0; offset < contents.length; offset += Number(WRITE_BUDGET)) {
      this.write(contents.subarray(offset, offset + Number(WRITE_BUDGET)))
      await this.blockingFlush()
    }
  }

  /** Every write starts at once, so a flush only has to be waited for. */
  flush (): void {
    if (this.#error !== undefined) throw this.#error
  }

  async blockingFlush (): Promise<void> {
    while (this.#inFlight !== undefined) await this.#inFlight
    if (this.#error !== undefined) throw this.#error
  }

  subscribe (): Pollable {
    return new Pollable(() => this.#inFlight === undefined, async () => { await this.#inFlight })
  }

  writeZeroes (len: bigint): void {
    this.write(new Uint8Array(Number(len)))
  }

  async blockingWriteZeroesAndFlush (len: bigint): Promise<void> {
    await this.blockingWriteAndFlush(new Uint8Array(Number(len)))
  }

  splice (source: InputStream, len: bigint): bigint {
    const budget = this.checkWrite()
    const chunk = source.read(len < budget ? len : budget)
    this.write(chunk)
    return BigInt(chunk.length)
  }

  async blockingSplice (source: InputStream, len: bigint): Promise<bigint> {
    const chunk = await source.blockingRead(len < WRITE_BUDGET ? len : WRITE_BUDGET)
    await this.blockingWriteAndFlush(chunk)
    return BigInt(chunk.length)
  }
}
