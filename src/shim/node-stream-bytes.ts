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
