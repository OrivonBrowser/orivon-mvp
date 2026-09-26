# `src/shim/http/`: `http` and `https` over a real `net.Socket`

**What lives here.** `http.ts` and `https.ts` (the modules), `client.ts` (`ClientRequest`),
`message.ts` (`IncomingMessage`), `parser.ts` (the HTTP/1.1 response parser), `headers.ts`,
`options.ts`, `agent.ts` (`http.Agent`/`https.Agent`, options stored, never pooled),
`status-codes.ts` and `unsupported.ts` (`createServer` refuses by name: there is no
`ServerResponse` layer).

**What it depends on.** [`../../contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
[`../node-errors.ts`](../node-errors.ts), [`../unimplemented.ts`](../unimplemented.ts),
[`../stream-bytes.ts`](../stream-bytes.ts) and [`../net/`](../net/) (every request runs over a
real `net.Socket`, and `https.ts` over `tls.ts`'s option checks).

**What it must never import.** `electron`, or [`../../broker/`](../../broker/) -- see the parent
README's "What it must never import".

**Owner stream.** `shim`, build step 3.

## Design notes

**[`client.ts`](client.ts) runs every request over a real `net.Socket` and never pools.**
`'socket'`, `'upgrade'`/`'connect'` and `res.socket` therefore hand the app the same kind of
object Node would, and a `createConnection` option is honoured. Every request opens its own
connection and closes it once the response ends, whatever `agent` it was given:
`http.Agent`/`https.Agent` exist so code can construct, pass and subclass them, and their options
are stored, never enforced. The one agent behaviour honoured is Node's merge of an https agent's
options into the TLS options, so `new https.Agent({ ca })` reaches the handshake the same way as
the request option. The request never half-closes its side after the body, because some servers
treat that FIN as an abort. `http.createServer` is not built: `net.createServer` is, but there is
no HTTP request parser or `ServerResponse` on top of it, and the refusal says so.
