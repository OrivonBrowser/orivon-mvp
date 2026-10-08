# ADR-0071: A dial can be abandoned by its app

- **Status:** accepted
- **Date:** 2026-10-08
- **Type:** architecture
- **Decided by:** owner (the behaviour, d-0595); AI recommendation for the shape, *provisional* until a ported peer-to-peer client discovers peers as fast as it does under Node

## Decision
`orivon.net.connect` and `orivon.net.connectSecure` take an optional `signal`, an `AbortSignal` in the
options object, as `fetch` does. Aborting it before the call settles abandons the dial, frees what the
dial held in the broker and rejects the call with `'closed'`. Aborting it after the socket was returned
does nothing; the app closes the socket it holds. A `signal` that is not an `AbortSignal` rejects with
`'invalid'`.

## Context
Under Node, `socket.destroy()` on a socket that is still connecting closes the attempt at once. Here
the dial ran to the broker's 30 s timeout and held one of the origin's in-flight slots meanwhile. A
peer-to-peer client abandons most dials after a few seconds, so its abandoned dials crowded out its
own file calls ('limit'), and the shim's dial queue that stops the refusals makes peer discovery
several times slower than under Node. The owner decided (d-0595) that a ported app keeps Node's
behaviour here.

## Alternatives considered
- **A cancel function on the returned promise.** A promise carries no methods, and a method on a
  wrapper object breaks `await orivon.net.connect(...)` for apps that expect a plain promise.
- **A cancel call by dial id.** The id exists only after the call settles, which is too late; a
  caller-chosen id would be a name the page invents for the broker to trust.
- **A new error code (`'aborted'`).** Adding a code is a breaking change for an app that switches on
  the closed set. `'closed'` already means an operation withdrawn on a handle.

## Reasoning
An `AbortSignal` is the web platform's own word for this, an app already holds one for `fetch`, and
the shim maps `socket.destroy()` onto it with no new concept. The signal lives in the page's world;
the preload turns an abort into a cancel message for the page's own pending call, so a page can
cancel only what it started.

## Consequences
The contract gains one optional field on two calls. The broker, IPC and preload carry a cancel for an
in-flight `net.connect`. The shim's dial queue is judged anew once dials can be cancelled.

## Reversibility
- **Cost to reverse:** moderate: an optional field apps may already pass.
- **What would make us revisit:** a platform change that lets an `AbortSignal` reach the broker
  directly, or a second cancellable call that wants a shared mechanism.
