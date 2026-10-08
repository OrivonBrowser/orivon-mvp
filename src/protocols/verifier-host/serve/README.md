# `src/protocols/verifier-host/serve/`: the loopback TLS server

**What lives here.** [`server.ts`](server.ts), the loopback TLS server that answers every host a
protocol serves (a `.eth` name, `<name>.<scheme>.orivon`, and each scheme's endpoint
`<scheme>.orivon`); its per-run self-signed certificate ([`certificate.ts`](certificate.ts)); the
per-host mount cache ([`sites.ts`](sites.ts)); and [`error-pages.ts`](error-pages.ts).

**What it depends on.** [`../../registry.ts`](../../registry.ts) and
[`../../address.ts`](../../address.ts), [`../protocol.ts`](../protocol.ts),
[`../egress.ts`](../egress.ts) and [`../../../loader/`](../../../loader/)'s range parser,
content-type map and redirect rule, reused rather than copied.

**What it must never import.** [`../../../main/`](../../../main/) beyond type-only imports, as the
parent README says.

**Owner stream.** `ens-ipfs`.

## Design notes

Why a loopback server and not `protocol.handle`, why every cache is kept per partition, how long a
name stays mounted, and why an install pins its root:
[`ADR-0030`](../../../../docs/decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md)
section Alternatives considered and its two amendments. Each limit is explained where it is defined.

**The certificate is DER-encoded here** ([`certificate.ts`](certificate.ts)), about sixty lines
over `node:crypto`; Chromium accepts it by fingerprint alone. `@peculiar/x509` would need a
process-global `reflect-metadata` polyfill, in the process that holds every untrusted parser.
