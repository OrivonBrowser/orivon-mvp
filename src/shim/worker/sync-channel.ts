// A Worker's synchronous calls to the page. The Worker posts the call on
// its MessagePort as usual and blocks in Atomics.wait; the page makes it on
// its own orivon and writes the reply into a SharedArrayBuffer the Worker
// sent it, one chunk at a time when the reply is larger than the buffer.
// SharedArrayBuffer exists only in a cross-origin isolated app.

/** Where a Worker's orivon keeps its synchronous twin (orivon-client.ts). Registered, so each bundle's shim finds the same one. */
export const SYNCHRONOUS = Symbol.for('orivon.synchronous')

const STATE = 0
const CHUNK_LENGTH = 1
const TOTAL_LENGTH = 2
const HEADER_BYTES = 16
const IDLE = 0
const READY = 1
/** One chunk of a reply; a larger one takes a round trip per chunk. */
const DATA_BYTES = 1 << 20

/** A reply with its byte arrays set apart, so a large read is copied, never spelled out in JSON. */
const BYTES_KEY = '__orivonBytes'

export function hasSharedMemory (): boolean {
  return typeof SharedArrayBuffer === 'function'
}

export function createChannelBuffer (): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + DATA_BYTES)
}

export function encodeReply (reply: unknown): Uint8Array {
  const blobs: Uint8Array[] = []
  const json = JSON.stringify(reply, (_key, value: unknown) => {
    if (!ArrayBuffer.isView(value)) return value
    blobs.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    return { [BYTES_KEY]: blobs.length - 1 }
  }) ?? 'null'
  const text = new TextEncoder().encode(json)
  const out = new Uint8Array(4 + text.length + blobs.reduce((sum, blob) => sum + 4 + blob.length, 0))
  const view = new DataView(out.buffer)
  view.setUint32(0, text.length)
  out.set(text, 4)
  let offset = 4 + text.length
  for (const blob of blobs) {
    view.setUint32(offset, blob.length)
    out.set(blob, offset + 4)
    offset += 4 + blob.length
  }
  return out
}

export function decodeReply (bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const textLength = view.getUint32(0)
  const blobs: Uint8Array[] = []
  for (let offset = 4 + textLength; offset < bytes.length;) {
    const length = view.getUint32(offset)
    blobs.push(bytes.slice(offset + 4, offset + 4 + length))
    offset += 4 + length
  }
  return JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + textLength)), (_key, value: unknown) => {
    const index = (value as Record<string, unknown> | null)?.[BYTES_KEY]
    return typeof index === 'number' ? blobs[index] : value
  })
}

/** The page's end: writes a reply, then each further chunk the Worker asks for. */
export class ReplyWriter {
  readonly #header: Int32Array
  readonly #data: Uint8Array
  #pending: Uint8Array = new Uint8Array(0)
  #offset = 0

  constructor (buffer: SharedArrayBuffer) {
    this.#header = new Int32Array(buffer, 0, HEADER_BYTES / 4)
    this.#data = new Uint8Array(buffer, HEADER_BYTES)
  }

  send (reply: Uint8Array): void {
    this.#pending = reply
    this.#offset = 0
    this.more()
  }

  more (): void {
    const length = Math.min(this.#data.length, this.#pending.length - this.#offset)
    this.#data.set(this.#pending.subarray(this.#offset, this.#offset + length))
    this.#offset += length
    this.#header[CHUNK_LENGTH] = length
    this.#header[TOTAL_LENGTH] = this.#pending.length
    Atomics.store(this.#header, STATE, READY)
    Atomics.notify(this.#header, STATE)
  }
}

/** The Worker's end: `request` posts the call; the reply is read chunk by chunk, asking for each next one with `more`. */
export function awaitReply (buffer: SharedArrayBuffer, request: () => void, more: () => void): Uint8Array {
  const header = new Int32Array(buffer, 0, HEADER_BYTES / 4)
  const data = new Uint8Array(buffer, HEADER_BYTES)
  // Reset before posting: the page may answer before this thread reaches the wait.
  Atomics.store(header, STATE, IDLE)
  request()
  let reply: Uint8Array | undefined
  let received = 0
  for (;;) {
    Atomics.wait(header, STATE, IDLE)
    const length = header[CHUNK_LENGTH] as number
    reply ??= new Uint8Array(header[TOTAL_LENGTH] as number)
    reply.set(data.subarray(0, length), received)
    received += length
    if (received >= reply.length) return reply
    Atomics.store(header, STATE, IDLE)
    more()
  }
}
