# Handle examples

One short, working example per handle type defined in `handle-contracts.md`. That document is
the specification and `src/contracts/handles.ts` is the same contract as TypeScript; this file
is neither — it is what calling either of them from an app actually looks like. Every snippet
below typechecks against `src/contracts/` as it stands today, not merely reads as consistent
with the prose.

Every example assumes an app's ordinary environment: the `orivon` global the preload injects
(`Orivon`, `src/contracts/capability-api.ts`), already present with no import needed. The two
lines below exist only so these snippets typecheck standalone; delete them and the rest is
exactly what app code writes. The five sections that follow all assume this block is prepended.

```ts
import type {
  Orivon, TcpSocket, TcpServer, UdpSocket, Datagram, FileHandle, IdentityHandle
} from '../../src/contracts/index.js'

declare const orivon: Orivon // the preload injects this; not written by app code
```

## §TcpSocket

Connect, write with real backpressure, half-close, then keep reading — the peer-wire shape
`handle-contracts.md` §TcpSocket calls out: a BitTorrent peer keeps sending choke/interested
messages long after this side has sent its last request, so closing `writable` must not take
`readable` down with it.

```ts
async function talkToPeer(host: string, port: number, handshake: Uint8Array): Promise<void> {
  const socket = await orivon.net.connect({ host, port })

  // write() resolves only once the broker has accepted the bytes into the OS
  // send buffer. Awaiting it is what makes this write-side backpressure
  // instead of a fire-and-forget that could race ahead of the peer.
  const writer = socket.writable.getWriter()
  await writer.write(handshake)

  // Half-close, not socket.close(): FIN goes out, writable becomes closed,
  // but readable stays open. socket.close() would sever both directions and
  // drop whatever the peer still has to say.
  await writer.close()

  const reader = socket.readable.getReader()
  for (;;) {
    const result = await reader.read()
    if (result.done) break // peer sent its own FIN -- both sides now terminal

    // Draining one read at a time is what keeps the credit window moving:
    // each read that empties the queue is what lets the broker extend more
    // credit and keep pulling from the OS socket. Stop reading here and the
    // broker stops reading the socket too -- backpressure that reaches the
    // peer, not a buffer silently growing in the broker.
    handlePeerMessage(result.value)
  }

  await socket.closed // resolves once both directions have reached a terminal state
}

declare function handlePeerMessage(chunk: Uint8Array): void
```

## §TcpServer

Accept by reading `connections`, not by listening for an event. The read *is* the accept: stop
calling it and the broker stops accepting, and the OS listen backlog pushes back on whoever is
trying to connect — the practical payoff of streams over an `EventEmitter`'s `'connection'`.

```ts
async function acceptLoop(port: number): Promise<void> {
  const server = await orivon.net.listen({ port })
  const reader = server.connections.getReader()

  for (;;) {
    const result = await reader.read()
    if (result.done) break // server closed -- e.g. its grant was revoked

    // Deliberately not awaited: handle this peer concurrently and go
    // straight back to read(). read() is what keeps the broker accepting; a
    // slow handler should stall only its own connection, never new accepts.
    void handlePeer(result.value).catch(reportPeerError)
  }
}

declare function handlePeer(peer: TcpSocket): Promise<void>
declare function reportPeerError(err: unknown): void
```

## §UdpSocket

Send a `Datagram`, read whatever comes back, and check `droppedInbound`. UDP already drops
packets on the wire; this is the same loss happening one layer up, silent by design because
DHT and tracker traffic is already built to tolerate it.

```ts
async function queryDht(
  localPort: number,
  peerAddress: string,
  peerPort: number,
  query: Uint8Array
): Promise<void> {
  const socket = await orivon.net.udpBind({ port: localPort })

  const writer = socket.writable.getWriter()
  await writer.write({ data: query, address: peerAddress, port: peerPort, family: 'IPv4' })

  const reader = socket.readable.getReader()
  const result = await reader.read()
  if (!result.done) handleDhtReply(result.value)

  // Not a bug and nothing to retry -- there is no "which datagram" here,
  // only a count. Logged for visibility into how lossy this socket's been.
  if (socket.droppedInbound > 0) reportDroppedDatagrams(socket.droppedInbound)

  await socket.close()
}

declare function handleDhtReply(datagram: Datagram): void
declare function reportDroppedDatagrams(count: number): void
```

## §FileHandle

`position` is explicit and required on every call, because a torrent writes piece *N* at
`N × pieceLength`, not wherever a cursor happens to be, and several pieces are routinely in
flight on the same handle at once — there is no shared cursor state for two concurrent writes
to race over.

```ts
async function storePiece(pieceIndex: number, pieceLength: number, data: Uint8Array): Promise<void> {
  const file = await orivon.fs.open('downloads/example.torrent.part', 'r+')
  const position = pieceIndex * pieceLength

  const written = await file.write({ position, data })
  if (written < data.length) throw new Error(`short write at piece ${pieceIndex}`)

  // Read back from the SAME explicit offset to verify. There is no cursor
  // this could accidentally inherit from -- piece 41 may be mid-write
  // further down the file while this runs.
  const check = await file.read({ position, length: data.length })
  verifyPieceHash(pieceIndex, check)

  await file.close()
}

declare function verifyPieceHash(pieceIndex: number, data: Uint8Array): void
```

## §IdentityHandle

`signEvent` takes and returns a structured event object, never raw bytes to sign — the broker
itself performs the serialisation and screens `kind`. Note that `object` is a loose enough type
that a raw `Uint8Array` would still satisfy the signature; nothing in the type system stops the
misuse. The rule is enforced by what the broker does with the value, not by what TypeScript
will accept, which is exactly why a raw-bytes signing oracle would be dangerous — it would let
anything that can reach this handle sign literally anything under the user's identity.

```ts
async function publishNote(content: string): Promise<void> {
  const identity = await orivon.id.requestIdentity({ kind: 'nostr' })
  if (identity === null) return // user declined the connect prompt

  const pubkey = await identity.publicKey()
  const unsigned = {
    pubkey: toHex(pubkey),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1, // text note -- signs silently after the initial connect; kind 0/3/5/22242 would prompt
    tags: [],
    content
  }

  const signed = await identity.signEvent(unsigned) // structured object in, structured object out
  await publishToRelay(signed)

  await identity.close() // releases this app's reference; does not disconnect the identity
}

declare function toHex(bytes: Uint8Array): string
declare function publishToRelay(event: object): Promise<void>
```

## Reference

- `docs/architecture/handle-contracts.md` — the specification these examples illustrate.
- `src/contracts/handles.ts` — the same five interfaces as TypeScript.
- `src/contracts/capability-api.ts` — the acquisition calls used above (`orivon.net.*`,
  `orivon.fs.*`, `orivon.id.*`).
