# `src/main/verifier/`: the shell's side of the verifier

**What lives here.** What the main process does for every host a protocol serves (`.eth` names,
`ipfs://` addresses): the resolver rules that send them to the verifier's loopback port, the
certificate check each session applies, starting and restarting the verifier host
([`../../protocols/verifier-host/`](../../protocols/verifier-host/)), the light client's
checkpoint ([`ADR-0031`](../../../docs/decisions/ADR-0031-helios-is-the-light-client.md)), what the
host verified between runs, the per-site partition stamp, the gateway proxy check, and the
wording of the status and a name's evidence for Settings and the site-info popover.
The person can switch the light client off in Settings (`web3.lightClient`, read when the host starts,
through `configureVerifier`); the environment switch still forces it off, and
[`web3-domain.ts`](web3-domain.ts) is what the Settings page reads.

**Tied to Electron.** [`verifier-subsystem.ts`](verifier-subsystem.ts) is the one file that
imports `electron`; the rest are `<name>.ts` decisions ([`../README.md`](../README.md)).

**What it depends on.** [`../../protocols/`](../../protocols/) (`verifier-host/protocol.ts`,
`builtin.ts`, `resolution/`), [`../dev/eth-resolver.ts`](../dev/eth-resolver.ts),
[`../../broker/`](../../broker/) (`grants/node-ledger-storage.ts`'s atomic write,
`policy/pin.ts`), [`../../loader/fetch/`](../../loader/fetch/) (`verifier-origin.ts`,
`content-root.ts`), [`../../trust/website-level.ts`](../../trust/website-level.ts),
[`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts), the top-level
`registry.ts`, `node:fs`, `node:net`, `node:path`.

**What it must never import.** The verifier host's code, as opposed to its protocol types: it
runs in another process, and only [`host-supervisor.ts`](host-supervisor.ts) talks to it.

**Owner stream.** `ens-ipfs`.

## Design notes

Each file's own header covers its rule (one owner of `--host-resolver-rules`, the synchronous
port probe, fingerprint-only certificates, request deadlines and backoff, the checkpoint's age).
What is here has no other home.

**The partition stamp is on the default session only** (`installPartitionStamp`, registered
through [`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts), LAST among that
session's `onBeforeSendHeaders` handlers so nothing earlier, an extension rule included, can set
or remove the header underneath it). Any `webRequest` listener sends its session's requests
through Electron's proxy, and then a redirect a `protocol.handle` handler returns reaches the
page with the redirect's status (`test/e2e-served-csp.test.ts` measures it). Cache-served apps
and web contexts serve `https` through such handlers, so a listener there would break every
routed redirect. None of their pages can reach the verifier anyway: their handlers dial through
Node's `https`, which cannot resolve a `.eth` name.

**The certificate check goes on every session, through `session-created`.** A partition without
it cannot load any host the verifier serves.

**The proxy check runs in main, not in the host** ([`proxy-check.ts`](proxy-check.ts)). It needs
`app.resolveProxy`, and a `utilityProcess` has no `session` to ask. It runs once per host start,
per gateway, since a PAC script can answer differently per URL.
