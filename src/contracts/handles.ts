// Transcribed from docs/architecture/handle-contracts.md. That document is the
// specification; this file must not diverge from it.
//
// ADR-0008: WHATWG streams are the durable interface. Node's shapes --
// EventEmitter sockets, `socket.end()`, an implicit file cursor -- are
// presented by orivon-node-shim one layer ABOVE this one, not here.
//
// ReadableStream, WritableStream and Uint8Array are ambient globals, available
// via tsconfig.json's lib: ["ES2023", "DOM", "DOM.Iterable"]. This file
// imports nothing; see scripts/check-contracts-pure.mjs.
//
// FOUR RULES THAT APPLY TO EVERYTHING BELOW. Each is a contract a future
// implementer will otherwise violate:
//
// 1. HANDLES ARE NEVER TRANSFERABLE. A MessagePort is transferable and carries
//    no sender identity, so a transferred handle would be a bearer capability
//    the broker cannot see. Handle tables are per-origin, and EVERY operation
//    re-checks ownership before it runs (security-model.md T11c). A handle ID
//    from one origin is rejected, not ignored, when presented by another.
//
// 2. EVERY HANDLE RECORDS THE GRANT THAT AUTHORISED IT, captured at
//    acquisition. That is what the revocation cascade walks
//    (handle-contracts.md SSRevocation): on revoke, every handle in the
//    grant's set closes immediately and abruptly -- RST, not FIN -- and every
//    promise the app is awaiting on it rejects with 'revoked'.
//
// 3. ANYTHING NODE EXPOSES SYNCHRONOUSLY IS RESOLVED BEFORE THE ACQUISITION
//    PROMISE SETTLES, and handed over as a plain, already-populated value.
//    Never a cache that starts empty and fills in from a later event. This is
//    the fix for the problem spike/gate1b/shim/dgram.js had to work around,
//    where `address()` was backed by a cache the 'listening' event filled.
//
// 4. EVERYTHING IS ASYNC. Node constructs sockets synchronously; across an IPC
//    boundary nothing can be. There is no 'connect' event and no observable
//    "connecting" state -- the resolution of the acquisition promise IS the
//    connect event. The shim reconciles this by buffering.

/** The base every handle returned by `orivon.*` shares. */
export interface Handle {
  /** Opaque; per-origin, not forgeable across origins (security-model.md T11c). */
  readonly id: string
  /** Resolves on clean close; rejects with an OrivonError otherwise. */
  readonly closed: Promise<void>
  /** Idempotent. */
  close(): Promise<void>
}

/**
 * A connected TCP socket.
 *
 * CLOSE AND HALF-CLOSE (handle-contracts.md SSTcpSocket):
 *
 * | action              | wire | readable      | writable | closed         |
 * |---------------------|------|---------------|----------|----------------|
 * | writable.close()    | FIN  | open          | closed   | pending        |
 * | peer sends FIN      | --   | ends, no error| open     | pending        |
 * | both of the above   | --   | closed        | closed   | resolves       |
 * | socket.close()      | FIN  | closed        | closed   | resolves       |
 * | writable.abort(e)   | RST  | errored       | errored  | rejects 'reset'|
 * | peer resets         | RST  | errored       | errored  | rejects 'reset'|
 * | grant revoked       | RST  | errored       | errored  | rejects 'revoked' |
 *
 * Closing the writable side does NOT close the readable side. That pairing is
 * Node's `socket.end()`, and half-close is load-bearing: a BitTorrent peer
 * connection sends a choke/interested handshake and keeps reading long after
 * it has stopped writing new requests. `closed` settles only once both
 * directions have reached a terminal state.
 *
 * BACKPRESSURE -- a credit window. The broker sends at most LIMITS
 * .readWindowBytes ahead of what the renderer has acknowledged consuming, and
 * when outstanding credit reaches zero it STOPS READING THE UNDERLYING OS
 * SOCKET rather than buffering in the main process. That propagates real TCP
 * backpressure to the remote peer; buffering in the broker would just move
 * unbounded memory growth from the renderer to the main process. See
 * ./ipc.js for the credit protocol and ./limits.js for the window size.
 */
export interface TcpSocket extends Handle {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  /**
   * The RESOLVED address the connection actually reached, not the hostname the
   * app asked for. Required by security-model.md T12: manifest patterns are
   * checked against resolved addresses, and an app inspecting what it
   * connected to must see the same address the policy check saw, or
   * DNS-rebinding-style confusion becomes possible again one layer up.
   */
  readonly remoteAddress: string
  readonly remotePort: number
  readonly localAddress: string
  readonly localPort: number
  setNoDelay(on: boolean): Promise<void>
  setKeepAlive(on: boolean, initialDelayMs?: number): Promise<void>
}

/**
 * A listening TCP server.
 *
 * Incoming connections arrive as a STREAM, not an event. This is the clearest
 * practical payoff of ADR-0008: if the app stops reading `connections`, the
 * broker stops ACCEPTING, and the OS listen backlog applies pressure back to
 * whoever is connecting. An EventEmitter's 'connection' event has no way to
 * say "not yet" -- every accepted connection is delivered whether the app is
 * ready or not.
 *
 * `connections` is created with highWaterMark: 0, so the broker never
 * pre-accepts a connection the app has not asked for by reading. Each read
 * accepts exactly one pending connection.
 *
 * Sockets delivered here are DERIVED HANDLES: they inherit the server's grant,
 * and closing the server closes every socket it produced that is still open.
 */
export interface TcpServer extends Handle {
  readonly connections: ReadableStream<TcpSocket>
  /**
   * Resolved before the acquisition promise settles, so requesting `port: 0`
   * (ask the OS to pick) still yields a real, populated value. Rule 3 above.
   */
  readonly localAddress: string
  readonly localPort: number
}

/** One UDP packet. The broker never splits or coalesces a datagram. */
export interface Datagram {
  data: Uint8Array
  address: string
  port: number
  family: 'IPv4' | 'IPv6'
}

/**
 * A bound UDP socket.
 *
 * Message-oriented, not byte-oriented -- this mirrors WebTransport.datagrams
 * rather than a Duplex. One Datagram chunk is exactly one UDP packet, on both
 * `readable` and `writable`.
 *
 * DATAGRAM LOSS IS EXPECTED AND IS NOT SIGNALLED AS AN ERROR. If the app is
 * not reading fast enough and the readable's internal queue is full, further
 * inbound datagrams are DROPPED and `droppedInbound` increments -- no error,
 * no rejected promise, no event. This is the one place in this file where
 * backpressure means "discard the data" rather than "slow the sender down":
 * UDP has no delivery guarantee, and DHT/tracker traffic is built to tolerate
 * loss. Buffering to avoid losing a datagram would convert a loss-tolerant
 * protocol into an unbounded memory growth path.
 *
 * No multicast in v0 -- addMembership/dropMembership are deliberately absent,
 * matching the recorded v0 limitation that local peer discovery is
 * unavailable.
 */
export interface UdpSocket extends Handle {
  readonly readable: ReadableStream<Datagram>
  readonly writable: WritableStream<Datagram>
  readonly localAddress: string
  /**
   * Resolved and populated at acquisition. THIS IS WHAT REMOVES THE
   * SYNCHRONOUS address() PROBLEM that spike/gate1b/shim/dgram.js worked
   * around with a cache filled by the 'listening' event -- under this contract
   * there is no cache to fill, because the value is already there.
   */
  readonly localPort: number
  /** Count of inbound datagrams discarded because the app was not reading. */
  readonly droppedInbound: number
}

export interface FileStat {
  size: number
  isFile: boolean
  isDirectory: boolean
  mtimeMs: number
}

/**
 * An open file, confined to the app's files directory.
 *
 * POSITION IS EXPLICIT AND REQUIRED ON EVERY POSITIONAL CALL -- there is no
 * implicit file cursor on this handle. A cursor is mutable state shared across
 * an async IPC boundary, which is a race the instant two writes to the same
 * handle are in flight, and a torrent writer routinely has many pieces in
 * flight at once. Node's familiar `position: null` form is presented by
 * orivon-node-shim, which owns and advances a local cursor and always sends an
 * explicit position underneath. A DELIBERATE, RECORDED DEVIATION from the
 * mirror-Node's-shapes rule: the shim absorbs it, so no app-facing code
 * changes, but the durable interface does not carry Node's shared-cursor
 * hazard forward.
 *
 * Positional read/write match what a torrent writer actually does -- piece N
 * is written at offset N * pieceLength, not appended sequentially. The stream
 * factories serve the bulk-transfer paths, such as feeding <video> from a
 * downloaded region.
 *
 * Paths are resolved and confined IN THE BROKER, never trusted from the
 * renderer. `..` segments, absolute paths, and symlinks that would escape are
 * rejected with 'denied' before any filesystem access (security-model.md
 * T1/T10). Writes are checked against the running per-origin quota counter
 * before they land; exceeding it yields 'limit'.
 *
 * EXCEPTION TO THE REVOCATION CASCADE: a FileHandle obtained through
 * orivon.fs.userSelected is authorised by the user's one-time OS picker
 * choice, not by the standing `fs` grant. Revoking `fs` does NOT close it --
 * but it does not survive an app restart either. A session-scoped exception,
 * not a standing grant of its own.
 */
export interface FileHandle extends Handle {
  /** Short read at EOF. */
  read(opts: { position: number, length: number }): Promise<Uint8Array>
  /** Returns bytes written. */
  write(opts: { position: number, data: Uint8Array }): Promise<number>
  readable(opts?: { start?: number, end?: number }): ReadableStream<Uint8Array>
  writable(opts?: { start?: number }): WritableStream<Uint8Array>
  stat(): Promise<FileStat>
  truncate(length: number): Promise<void>
  sync(): Promise<void>
}

/**
 * A named identity the user has connected to this origin.
 *
 * No readable/writable -- this is not a byte channel. It is modelled as a
 * handle because it is revocable and origin-scoped like every other
 * capability, not because it streams anything.
 *
 * NO RAW-BYTES SIGNING ORACLE. Binding contract rule, so it cannot be quietly
 * reintroduced by an implementation detail: signEvent takes and returns a
 * structured event OBJECT, and the broker performs the serialisation. An
 * interface accepting pre-serialised bytes would let a compromised client sign
 * literally anything under the user's identity -- wipe the follow list (kind
 * 3), delete posts (kind 5), replace the profile (kind 0), or authenticate to
 * relays (NIP-42, kind 22242) -- and ADR-0003 excludes export, so the user
 * could not rotate away from it.
 *
 * Event-kind screening: kinds 1/6/7 sign silently after the initial connect;
 * kinds 0, 3, 5, 22242 and any delegation event prompt every time.
 *
 * close() releases THIS APP'S reference. It does NOT disconnect the named
 * identity from the origin -- disconnecting is a user action in browser
 * chrome. Without this rule an app could force a fresh connect prompt on
 * demand by closing and immediately re-requesting, which is exactly the
 * prompt-fatigue outcome named identities exist to avoid.
 */
export interface IdentityHandle extends Handle {
  /** e.g. 'nostr'. */
  readonly kind: string
  /** The SAME key on every origin the user has connected this identity to. */
  publicKey(): Promise<Uint8Array>
  /** Structured; the broker serialises and screens `kind`. */
  signEvent(event: object): Promise<object>
}
