// Shared by every module here that accepts a Node-style chunk (string or
// Uint8Array/Buffer) and must hand a WHATWG stream a real Uint8Array --
// node-http-client.ts, node-net-socket.ts and node-dgram-socket.ts all had
// their own five-line copy of this before it moved here (Rule 3).

/** Buffer extends Uint8Array, so this also accepts a real Node Buffer. */
export function toBytes (chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
  throw new TypeError('orivon-node-shim: stream chunks must be a string or Uint8Array')
}

/**
 * The same normalisation for Node's ARRAY chunk form -- `dgram.send()`
 * documents `msg` as "Buffer | TypedArray | DataView | string | Array", and
 * an array is sent as the concatenation of its pieces. Kept beside `toBytes`
 * rather than copied into node-dgram-socket.ts because this module is already
 * where a Node-style chunk becomes a Uint8Array (Rule 3 -- six separate
 * concat helpers already exist in this tree, and a seventh is the thing that
 * rule exists to stop).
 *
 * `dgram.send()` is the only caller: no stream write in this tree takes an
 * array, so `toBytes` itself is deliberately NOT widened to accept one.
 */
export function toBytesJoined (chunks: readonly unknown[]): Uint8Array {
  const parts = chunks.map(toBytes)
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
