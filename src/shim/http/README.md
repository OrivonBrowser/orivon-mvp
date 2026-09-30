# `src/shim/http/`: `http` and `https` over a real `net.Socket`

**What lives here.** Node's `http` client and server.

- **Client** ([`client.ts`](client.ts), [`agent.ts`](agent.ts), [`https.ts`](https.ts)): every
  request runs over its own real `net.Socket` (a `TLSSocket` for `https`) and is never pooled.
- **Server** ([`server.ts`](server.ts), [`server-connection.ts`](server-connection.ts),
  [`server-response.ts`](server-response.ts), [`outgoing-message.ts`](outgoing-message.ts)):
  `http.createServer` over `net.Server`, hence over `orivon.net.listen`. `https.createServer` refuses
  by name: `orivon.net` has no TLS listener to run a server over.
- **Shared** ([`parser.ts`](parser.ts) the message framing, [`request-parser.ts`](request-parser.ts)
  the request head, [`message.ts`](message.ts) `IncomingMessage`, [`headers.ts`](headers.ts),
  [`header-validation.ts`](header-validation.ts), [`status-codes.ts`](status-codes.ts)).

**Why the server exists.** Node apps commonly run a small HTTP server of their own on loopback, to
serve pages or an API to themselves, and a ported one cannot run without `http.createServer`.

**What it depends on.** [`../../contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
[`../node-errors.ts`](../node-errors.ts), [`../unimplemented.ts`](../unimplemented.ts),
[`../stream-bytes.ts`](../stream-bytes.ts) and [`../net/`](../net/).

**What it must never import.** `electron`, or [`../../broker/`](../../broker/): see the parent
README's "What it must never import".

**Owner stream.** `shim`, build step 3.

## What the server does, and what it only stores

| Built | Notes |
|---|---|
| `createServer([options][, listener])`, `new Server()`, `listen` (the forms `net.Server` has), `close`, `address`, `listening`, `getConnections`, `closeIdleConnections`, `closeAllConnections`, `setTimeout` | A `Server` is a `net.Server`. |
| Events `request`, `connection`, `listening`, `close`, `error`, `clientError`, `checkContinue`, `checkExpectation`, `upgrade`, `connect`, `timeout` | An `upgrade` request with no listener is an ordinary request; a `CONNECT` with no listener is closed. |
| Request: `IncomingMessage` with `method`, `url`, `headers` (Node's joining rules), `rawHeaders`, `headersDistinct`, `trailers`, `httpVersion`, `socket`, `complete`, `aborted` and a body with backpressure | `Content-Length` and chunked bodies. |
| Response: `ServerResponse`, `OutgoingMessage`, `writeHead` (every overload), the header methods, `write`, `end`, `flushHeaders`, `addTrailers`, `writeContinue`, `writeProcessing`, `writeEarlyHints`, `'finish'`, `'close'`, `'drain'` | Framing, `Date`, `Connection` and `Keep-Alive` follow Node's rules. |
| Options `IncomingMessage`, `ServerResponse`, `keepAliveTimeout`, `headersTimeout`, `requestTimeout`, `timeout`, `requireHostHeader`, `maxHeaderSize`, `noDelay`, `keepAlive` | Applied. |
| `http.STATUS_CODES`, `METHODS`, `maxHeaderSize`, `validateHeaderName`, `validateHeaderValue` | |
| **Stored only:** `maxHeadersCount`, `maxRequestsPerSocket`, `connectionsCheckingInterval`, `insecureHTTPParser`, `joinDuplicateHeaders`, `highWaterMark` and the other options Node lists | No behaviour hangs on them: no header count or per-connection request cap is applied, and the timeouts below run on their own timers instead of a periodic sweep. |
| **Not built:** `https.createServer`, `http.setMaxIdleHTTPParsers`, `Server[Symbol.asyncDispose]` | They refuse by name or are absent. |

## Design notes

**A connection answers one request at a time** ([`server-connection.ts`](server-connection.ts)).
Bytes a pipelining client sends behind a request wait, and the socket is paused once they pass 64
KiB, until the response has finished. A response that finishes before its request body was read
throws the rest of the body away, so the next request is reached; a `Connection: close` response
does not wait for it.

**Node's answer to a client's FIN is kept.** Node does not hold a half-open connection: a request
still waiting for its response is aborted (`'aborted'`, then `'close'` on both objects) and the
connection ends, and a request cut off part-way goes through `clientError` (400 by default). A
client that sends its request and closes its write side before an asynchronous handler answers
therefore gets nothing, as it would from Node.

**`close()` waits for requests in flight, where `net.Server.close()` does not.**
[`../net/server.ts`](../net/server.ts) closes every accepted socket with the listener, because the
broker closes a server handle's derived sockets. `http.Server` holds that close back until the
last connection that is answering a request has finished, and closes idle ones at once; the net
listener stays bound until then, so the port keeps accepting and then closing new connections until
the last request finishes, where Node would refuse them at the port. `listen()` in that window
throws `ERR_SERVER_ALREADY_LISTEN` and leaves the pending close alone. A socket handed over by
`upgrade` or `connect` counts as connected until it closes.

**The timeouts run on plain timers.** `headersTimeout` and `requestTimeout` answer `408` through
`clientError`, and `keepAliveTimeout` closes an idle connection, each at the time given, where
Node checks them on a sweep every `connectionsCheckingInterval`. `headersTimeout` counts from the
connection's start for its first request, so a connection that sends nothing gets the `408`. `server.timeout` is the socket's
idle timeout, and the `timeout` event is raised on the request, the response and the server in
Node's order.

**`ServerResponse` is a legacy `Stream`, as Node's is, not a `stream.Writable`.** Its `_header`,
`_hasBody`, `_last` and `_implicitHeader` are the names middleware reaches for. `ClientRequest` is
not built on `OutgoingMessage`, so `req instanceof http.OutgoingMessage` is false for a client
request.

**A request's `host`, `content-type` and the other single-valued headers keep their first value**
when repeated, and `cookie` joins with `; `, as a Node server's `req.headers` does
([`request-parser.ts`](request-parser.ts)); the client's response headers keep the plain
`, ` join.

**A throwing request listener is reported as an uncaught error, off the parse loop.** The socket
callback that fed the parser would otherwise turn it into an unhandled rejection and leave the
connection half-parsed.

**`listen` takes the hosts `net.Server` takes.** A loopback host binds loopback only, under the
local grant; no host asks for every interface and falls back to loopback when only the local
grant is held: see [`../net/README.md`](../net/README.md).
