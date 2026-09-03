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

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**Why [`fetch-bundle.ts`](fetch-bundle.ts) is its own file, not part of `index.ts`.** Split out
per [`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 2 — it owns exactly
one concern: turning `(fetch, hintedUrl, assetPaths)` into a validated bundle. TOFU versus
`decideUpdate()` branching, and persistence, are `index.ts`'s job, not this file's.

**`assetPaths` is an explicit parameter to `fetchBundle`, not discovered from the manifest.**
`Manifest` ([`src/contracts/manifest.ts`](../contracts/manifest.ts)) has no field naming an
app's frontend files — only `entry`, one HTML file — and nothing in the doc corpus specifies a
discovery or crawl mechanism. Filed as [`open-questions.md`](../../docs/open-questions.md) A45
rather than guessed at. Everything downstream of "here is the asset URL set" is fully
implemented.
