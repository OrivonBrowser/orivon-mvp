# `src/broker/transport/` — how a page reaches the broker, and how bytes move

**What lives here.** The Electron IPC front door, its message validation, the per-origin rate
limiter, and the credit-window byte pumps that relay a socket over a dedicated `MessagePortMain`.

**What it depends on.** `electron`, [`../index.ts`](../index.ts), [`../handles/`](../handles/),
[`../adapters/`](../adapters/), [`../grants/`](../grants/), [`../policy/origin.ts`](../policy/origin.ts)
and [`src/main/`](../../main/)'s channel and registry definitions.

**What it must never import.** [`src/shim/`](../../shim/), [`src/loader/`](../../loader/),
[`src/preload/`](../../preload/) or any renderer code. This directory is the trust boundary;
importing something on the far side of it inverts the trust direction.

**Owner stream.** `broker` — build step 2.

## The two rules this directory exists to enforce

**Every call is attributed to the origin of the SENDING FRAME**, derived via
[`../policy/origin.ts`](../policy/origin.ts)'s `originFromSenderFrame` — never to anything the
renderer put in the payload (T3). A compromised renderer process can reach this channel
directly, so `method` and `payload` are validated here defensively rather than trusted because
the preload is well-behaved.

**Bytes never travel over request/response IPC.** `net.connect` returns a plain descriptor and
separately hands the frame a dedicated port; the read pump ([`port-pump.ts`](port-pump.ts)) and
the write sink ([`port-sink.ts`](port-sink.ts)) relay over that, each bounded by a credit window
so neither side can outrun the other. Per-message IPC is far too slow for torrent-rate data
([`contracts/ipc.ts`](../../contracts/ipc.ts)).

See [`../README.md`](../README.md)'s design notes for the socket-teardown rationale, which spans
this directory and [`../adapters/`](../adapters/).
