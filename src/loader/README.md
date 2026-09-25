# `src/loader/`: the app loader

**What lives here.** Manifest discovery at `/.well-known/orivon.json`, asset fetch and cache,
per-version hash pinning, the hash tree a site publishes about its bundle
(`/.well-known/orivon-ddoc.json`), and the update decision (silent / re-consent / capability
prompt / reject).

| Folder | Holds |
|---|---|
| (top level) | `index.ts` (`createLoader`/`load()` orchestration), `load-result.ts`, `subsystem.ts`, `dev-serve.ts`, `leaf-hash.ts` and `ddoc-declaration.ts` (used across every folder below, so kept out of any one of them) |
| [`manifest/`](manifest/) | Parsing and validating the manifest |
| [`fetch/`](fetch/) | Turning a hint into a validated bundle |
| [`cache/`](cache/) | Writing and pruning what's on disk |
| [`serve/`](serve/) | Answering a request against the pinned bundle |
| [`reach/`](reach/) | The third-party reach path |
| [`electron/`](electron/) | The Electron-specific machinery: `protocol.handle`, `net`, DNS |

**What it depends on.** [`src/contracts/`](../contracts/) and [`src/broker/`](../broker/)
(for storage and the grant ledger).

**What it must never import.** [`src/shim/`](../shim/).

**Owner stream.** `loader`, build step 4.

**Never probe automatically.** An unsolicited request to every origin the user visits is an
active, attributable *"this visitor runs Orivon"* signal, sent from a privacy-branded browser.
Discovery is a `<link rel="orivon-manifest">` hint in HTML already delivered, the only
trigger; there is no separate user action, a Web3site is the URL, not a thing to convert a
website into (`capability-api.md` §How a URL becomes an app). The well-known path is fetched
**only after** seeing that hint.

**The update decision is where a silent failure is a security failure.** Its failure mode is
"no prompt appeared", which no manual checklist catches, and the capability at stake is
`tcp.connect *:*`. Re-consent triggers on a **subset check over the granted pattern set**, not
on capability kinds; see [`capability-api.md`](../../docs/architecture/capability-api.md) A9 §2.
A kind the person switched off from the site-info popover (`../main/permissions/site-switches.ts`)
is the one exception: `LoadContext.declinedCapabilities` drops it from that check when it is not
currently held (`../broker/policy/manifest-patterns.ts`'s `withoutSwitchedOffCapabilities`), so a
still-declared but turned-off capability does not resurface as a prompt on every later visit —
but ONLY when it is unheld; a manifest widening a capability that IS still granted is never
exempted, and any other change to the code still forces the ordinary re-consent path.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**Why `manifest/`, `fetch/`, `cache/`, `serve/`, `reach/` and `electron/` are each their own
folder.** See each folder's own `README.md` for what belongs to it and why it is shaped the way
it is; this file covers only what is common to the whole directory, or belongs to a top-level
file.

**A bundle never sits whole in memory: bytes stream to staging and are hashed from there.**
The byte caps (`bundle-hash.ts`'s `MAX_ASSET_BYTES`, 64 MiB, and `MAX_BUNDLE_BYTES`, 512 MiB;
an owner decision, sized for a real built frontend with a 31 MB wasm-heavy chunk and room to
grow) bound download and disk, so memory must stay flat however close a bundle comes to them.
Each response body is written chunk by chunk into the origin's **staging area**
(`apps/<origin-hash>/staging/`, a sibling of `code/`, never inside it), then hashed by reading
that file back through [`leaf-hash.ts`](leaf-hash.ts): node:crypto's incremental SHA-256 fed
`bundle-hash.ts`'s own `leafPrefix`, so the byte layout stays defined once and only the engine
differs from the WebCrypto one `bundleTree` uses. Hashing reads the file back rather than hashing
as bytes arrive because the leaf preimage puts the content's length BEFORE the content, and a
declared `Content-Length` is advisory. The root comes from `bundleTreeFromLeaves`, which applies
exactly the validation `bundleTree` does. Only the manifest is held in memory, and it is bounded
by `MAX_MANIFEST_BYTES`. A fetched bundle waiting on a prompt waits in staging too
(`StagedAsset` names its bytes, never carries them); the next fetch for that origin, or a
refused one, clears it.

**The site's published hash tree is carried, never judged.**
[`ddoc-declaration.ts`](ddoc-declaration.ts) fetches `/.well-known/orivon-ddoc.json` after the
manifest, with the same pinned addresses and byte budget, and never after a 304.
[`cache/install.ts`](cache/install.ts) stores it as `ddoc.json` beside `pin.json`, and
[`../trust/ddoc.ts`](../trust/ddoc.ts) compares the two when the Web3 Score page asks
(`ADR-0029`). Nothing in this directory reads the tree to decide anything, for two reasons. The
owner put that decision with the Web3 Score. And a tree served by the same host as the files
cannot stop that host. So a 404, an unreadable file and a mismatch all install exactly as they
would without it. The old tree is removed before a new pin is written, so an interrupted install
leaves "not published", never an earlier bundle's tree failing the new pin. Storing it can fail
without failing the install, because it is evidence, not identity.

**A declined capability is asked about once, not on every visit.** `decideUpdate()` compares the
new manifest with what the origin holds; a capability the person declined at install, or revoked
since, is never held, so comparing against held grants alone would read every visit as "the app
wants more" and raise the capability prompt again. `index.ts` therefore also passes the pinned manifest's own declared set
(`previouslyDeclaredPatterns`), read back only when its bytes still hash to the pin's manifest
leaf: authority the person was already asked about counts as covered. That grants nothing -- the
declined capability stays ungranted -- and a request outside both sets still prompts.
