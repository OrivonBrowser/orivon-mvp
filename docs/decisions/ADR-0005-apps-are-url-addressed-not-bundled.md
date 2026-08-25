# ADR-0005: Apps are URL-addressed and cached, never bundled into the browser

- **Status:** accepted
- **Date:** 2026-08-18
- **Type:** architecture
- **Decided by:** owner concern, resolved by AI recommendation

## Decision
An Orivon app is **addressed by URL and fetched over the network**, then cached locally and
run from that cache. No application is compiled into the browser binary.

The installer contains only: the **shell**, the **capability broker**, and first-run entries
that *point at URLs*. The flagship torrent app ships **pre-cached, not bundled** — delivered
by the same mechanism as any third-party app, merely with a warm cache so that first run
works before any network fetch.

## Context
The owner raised the concern that bundling app executables (torrent, Nostr, and future apps)
would inflate the MVP's size, and stated the original intent was to *"delegate those to URLs"*.

The size argument turns out not to hold, and this is recorded so it is not re-litigated:

| | installed size |
|---|---|
| Electron runtime (Chromium + Node) | ~150–200 MB — unavoidable floor |
| Torrent app frontend + `webtorrent` | ~2–4 MB |
| Nostr | ~0 — `window.nostr` injection only; the client is a third-party website |

Apps are under 2% of install size. Bundling would not be noticeable, and a future Chromium
fork will be the same size or larger.

**The decision is nonetheless URL-delivery**, for reasons that are architectural rather than
about bytes.

## Alternatives considered
- **Bundle apps into the installer.** Rejected. Not on size, but because a browser that ships
  its apps inside itself *is* "a browser with built-in Web3 features" — precisely the product
  the owner has repeatedly ruled out. It would also couple every app release to a browser
  release.
- **Fetch apps but do not cache.** Rejected: breaks offline use, breaks local executability,
  and re-introduces per-load trust in a remote server — which is exactly what the
  Trustlessity ladder penalises.
- **Special-case the flagship as a privileged builtin.** Rejected as the *design*, retained
  only as a fallback if the spike below fails. It would violate the ADR-0002 test that the
  torrent app must be buildable using only the public capability API.

## Reasoning
Three arguments, none of which is about install size:

1. **It is the thesis.** "Apps open as a URL" is the product claim. If the apps are inside
   the browser, the claim is unproven and the execution layer is an internal implementation
   detail of a torrent client.
2. **Independent update cadence.** Apps ship without shipping a browser release, and a
   browser release does not force app churn.
3. **It makes "installable Web3sites" real.** Fetch-then-run-locally is exactly the mechanism
   the public docs describe, and it is what gives local-executability something to mean.

Delivery model: fetch **manifest + frontend assets** from a URL → show the capability grant
prompt → cache into that app's storage domain (ADR-0003) → run from cache thereafter, with
update checks. HTTPS in the MVP; IPFS and ENS-addressed delivery later, once trustless
resolution exists.

## Consequence that changes the build plan
If an app is fetched from a URL, **its backend cannot run in the Electron main process** —
that would be arbitrary remote code with full Node authority. Therefore `webtorrent` must run
in the **renderer**, reaching the network through `orivon.net` via shimmed `net` / `dgram`.

Therefore **`orivon-node-shim` moves from month 2 into month 1.** It is not a
developer-acquisition tool; it is load-bearing for the flagship. The upside is that the
flagship becomes the shim's proof, and the ADR-0002 genericity test is exercised in week 2
rather than month 6.

**Open technical risk — resolve by spike in week 1, before building on it:** can `webtorrent`
run in a renderer over shimmed `net`/`dgram` at acceptable throughput? Torrent data crossing
the IPC boundary per-packet may be too slow. Planned mitigations: `MessageChannelMain` ports
for socket data rather than per-message IPC, and video via MediaSource.

- **If the spike succeeds:** the torrent app is a genuine URL-delivered app; everything is
  consistent.
- **If it fails:** run webtorrent privileged in the main process for the MVP, record it as
  known debt, and revisit when `orivon-runtime` lands. Failing in week 1 is cheap; failing in
  week 4 is not.

Estimated cost: roughly **+2 days** (the torrent estimate already included wiring webtorrent
to capabilities). Recommended offset: let the trust indicator slip, as the least load-bearing
item in the month.

## Consequences
- Requires an app fetch/cache/update subsystem in the MVP — modest, and it reuses ADR-0003's
  per-app storage domains.
- Cached app code must be **integrity-checked**, otherwise a compromised host silently
  replaces an app that already holds capability grants. This is where DDOC eventually belongs,
  and it is the first genuinely load-bearing use for it.
- A URL-addressed app's **origin becomes its identity** — it keys the storage domain, the
  grant ledger, and the derived key from `orivon.id`. Origin definition must therefore be
  settled precisely before the first grant is ever persisted.
- Offline first-run works only for pre-cached apps; everything else needs the network once.

## Amendment (2026-08-25, morning): publisher-key continuity for updates — **SUPERSEDED**
As originally written, *any* bundle change broke the pin and re-prompted, so every legitimate
update would interrupt the user, and prompt fatigue trains users to click through the one
prompt that matters. The accepted refinement pinned the **publisher's signing key** (TOFU on
the key, not the hash), applied same-key updates silently, and re-consented on key change, new
capability, or an unsigned bundle.

## Amendment (2026-08-25, evening): signing is cut from v0 — supersedes the above

The multi-agent audit (`planning/audit-2026-08-25.md`) found the signing mechanism was
**load-bearing in three ADRs and specified nowhere**: no signature format, no covered bytes, no
detached-signature location, no key generation, no tooling, and no build step. As written,
`publisherKey` was a self-asserted string inside the very document it was meant to
authenticate, fetched from the host it was meant to defend against — a field, not TOFU.

The claim above that *"a compromised host without the signing key can no longer push accepted
code at all"* was also **false for a second reason**: such a host does not need to push code.
It serves a **302** to an attacker origin, which then runs with the app's preload and grants
(`security-model.md` T18); or it serves one unsigned `<script>` into a code-split chunk the
pinned asset set never covered (T21). The signed bundle is never touched.

**Owner decision: cut the signing tier from month 1.** There is exactly one publisher, so the
amendment solved prompt fatigue that cannot yet occur.

**What v0 ships instead:**
- **Hash-pinning (TOFU on the bundle)** as the sole integrity mechanism.
- Re-consent on hash change, on **capability-pattern widening** (a subset check, not a
  kind comparison — `capability-api.md` open item 2), or on a **version rollback**.
- Cached assets served at the app's own origin with a **fail-closed** rule: a same-origin
  request whose path is not in the pinned set is denied, not fetched. Re-verify the cached tree
  **at every load**, not only at fetch.
- **No UNSIGNED badge anywhere**, since "unsigned" is not a distinction when everything is —
  and a red badge on the flagship would have sabotaged the clip.

Signing returns when a second publisher exists, which is also when its stated justification
first applies.

## Reversibility
- **Cost to reverse:** cheap. Nothing prevents bundling an app later if there is a reason.
- **What would make us revisit:** an app whose licence or size genuinely requires shipping
  inside the installer.
