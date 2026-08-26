# `src/loader/` — the app loader

**What lives here.** Manifest discovery at `/.well-known/orivon.json`, asset fetch and cache,
per-version hash pinning, and the update decision (silent / re-consent / capability prompt /
reject).

**What it depends on.** [`src/contracts/`](../contracts/) and [`src/broker/`](../broker/)
(for storage and the grant ledger).

**What it must never import.** [`src/shim/`](../shim/).

**Owner stream.** `loader` — build step 4.

**Never probe automatically.** An unsolicited request to every origin the user visits is an
active, attributable *"this visitor runs Orivon"* signal, sent from a privacy-branded browser.
v0 discovery is a `<link rel="orivon-manifest">` hint in HTML already delivered, or explicit
user action ("Open as app"). The well-known path is fetched **only after** one of those.

**The update decision is where a silent failure is a security failure.** Its failure mode is
"no prompt appeared", which no manual checklist catches, and the capability at stake is
`tcp.connect *:*`. Re-consent triggers on a **subset check over the granted pattern set**, not
on capability kinds — see [`capability-api.md`](../../docs/architecture/capability-api.md) A9 §2.
