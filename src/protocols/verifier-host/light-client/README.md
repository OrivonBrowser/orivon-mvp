# `src/protocols/verifier-host/light-client/`: proving a `.eth` name

**What lives here.** `light-client.ts` (Helios, behind one EIP-1193 provider), `helios-errors.ts`,
`rpc-failover.ts` (trying execution RPCs in turn per request) and `clock.ts` (a computer whose clock
is behind or ahead of the chain).

**What it depends on.** [`../egress.ts`](../egress.ts), [`../protocol.ts`](../protocol.ts) and
`@a16z/helios`.

**What it must never import.** [`../../../main/`](../../../main/) beyond type-only imports, as the
parent README says.

**Owner stream.** `ens-ipfs`.

## Design notes

**Helios needs four wrappers**
([`ADR-0031`](../../../../docs/decisions/ADR-0031-helios-is-the-light-client.md) section Decision): a
`WorkerGlobalScope` shim, or its WebAssembly timer panics on the first failed consensus request; a
URL on every response, since Electron's `net.fetch` leaves it empty and Helios throws parsing it;
its revert text as `{ code: 3, data }`, or viem never sees a CCIP-Read `OffchainLookup`; and
execution RPCs tried in turn, or one RPC's short proof window fails the name.

**One failed head refresh leaves the client `synced`; a second in a row, or a proven head over two
minutes old, does not** (ADR-0030's 2026-09-26 amendment). A checkpoint read never changes sync
state.

**A client of each tunnel proves the names of the websites in its profile, in the same process as the shared client.** Helios reaches the network only through the process's global `fetch`, and a request names no website, so one client cannot take a route per call. `light-client.ts` replaces `globalThis.fetch` once with a dispatcher that holds a lane per client: the shared client keeps the real server addresses, and a tunnel's client is told `https://<tunnel>-execution.orivon.invalid` and `https://<tunnel>-consensus.orivon.invalid` (`nym` or `socks5`) for its two servers. The dispatcher maps a request back to the real server and sends it on that client's own allowlisted fetch (the routed fetch of that tunnel), and refuses any other address. A tunnel's client starts at the first `.eth` name of a website in that tunnel's profile, reports no status to the shell, and its sync runs wholly through the tunnel, which is slow to open the first time: that name can answer "still syncing; reload in a moment" once.

**A clock that is behind or ahead of the chain is allowed for, for Helios alone.** Helios refuses any update signed in a slot its clock has not reached, with no slack, so a computer whose clock lags more than a few seconds fails every sync with `invalid timestamp`; and it refuses a newest block more than 60 s older than its clock, so a computer whose clock runs about that far ahead fails reading it with `out of sync: N seconds behind`. When either exact failure comes, `light-client.ts` reads the `Date` header of the consensus server and each execution RPC through the client's own allowlisted fetch (so a tunnel's client asks through its tunnel), and `clock.ts` takes the middle of the largest group of them that agree within 30 s, when that group is at least two and a majority of the servers asked and puts the clock off by 2 s to 24 h, in either direction (a server off by itself is left out). Helios is then started again at once with that lead added to its clock, positive for a clock that is behind and negative for one that is ahead: `Date.now` is wrapped once for the process and adds the lead only when the stack shows a frame under `node_modules/@a16z/helios/`, so certificates, cache lifetimes and retry times read the true time (this relies on Helios staying an external dependency of the verifier host bundle; bundled in, its frame would carry another path and the lead would never reach Helios: after the one immediate retry the failure would read as Helios's own text). Nothing weakens a proof: signatures are still checked, and a wrong clock cannot make Helios accept a forged header. A positive lead decides what is too new to accept; a negative one lets Helios take a newest block up to its size older than the 60 s bound. So a lie can at worst hand Helios older, validly signed data, which a stale server can already, and it takes most of the servers asked agreeing on the time to tell it (servers of one operator cannot decide alone: with four origins asked, a group of three is needed). It measures again after the system clock is set back (a jump the monotonic clock did not see), after it is set forward or the computer wakes while a lead is lent, when a refresh falls out of sync, and when the client stalls or fails while a lead is lent (a lead that is too large fails too). A measurement sets the lead to what the servers said, so one of 0 takes it back; one that cannot be made keeps the lead and is tried again at most once a minute. When the servers cannot tell, the failure reads as a plain-words reason (`CLOCK_BEHIND_REASON` for `invalid timestamp`, `CLOCK_AHEAD_REASON` for `out of sync`) in Settings and on a `.eth` error page; when they say the clock is right, `invalid timestamp` reads as Helios's own text and `out of sync` as a server being behind the chain (`serverBehindReason`). The lead is shown on the synced state (`clockLeadMs`, negative when the clock is ahead) and Settings says it. A computer with a right clock never measures anything, and the wrapper reads no stack while the lead is 0.
