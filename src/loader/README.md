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

Why the code here has the shape it has, per
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 — a source comment
warns about a trap; the argument for a design belongs here.

**The asset list is an explicit parameter to `fetchBundle`, not discovered from the manifest**
([`fetch-bundle.ts`](fetch-bundle.ts)). `Manifest` ([`src/contracts/manifest.ts`](../contracts/manifest.ts))
has no field naming an app's frontend files — only `entry`, one HTML file — and nothing in the
doc corpus specifies a discovery or crawl mechanism. Filed as
[`open-questions.md`](../../docs/open-questions.md) A45 rather than guessed at. Everything
downstream of "here is the asset URL set" is fully implemented.

**The manifest is always fetched from exactly `<origin>/.well-known/orivon.json`**
([`capability-api.md`](../../docs/architecture/capability-api.md) §How a URL becomes an app),
never from a path component of `hintedUrl`. Not a stylistic choice: `bundleTree()` rejects any
bundle with no leaf at that literal canonical path (`canonical-path.ts`'s `MANIFEST_PATH`), so
a manifest fetched from anywhere else could never produce an accepted bundle. `hintedUrl` names
which *origin* is being installed, nothing more.

**Canonical paths come from the fetch response's resolved URL**, never the requested one — the
same "trust what happened, not what was asked for" stance `origin.ts`'s `originFromSenderFrame`
takes for T3.
