# Orivon security review — owner's briefing

> **FREEZE LIFTED 2026-09-11 (owner). This paragraph is no longer in force.** It said `main` was
> frozen until the owner lifted it, and it never said what would end the freeze -- which
> contradicted the review run's own standing rule to merge green PRs as they land, and parked
> fifteen finished PRs for six hours. The scan has run; the reason is spent. **`main` moves
> again.** If you need the tree to hold still for a fresh scan, ask for a freeze with an explicit
> end condition, and say which commit you bound to.

**Commit the first scan was run against: `fdb884a`.** Findings written against that tree may
refer to code that has since changed -- check before reporting.

---

## 1. What Orivon is, in the only terms that matter here

It is a browser that deliberately gives ordinary web pages what a browser normally refuses them:
raw TCP and UDP sockets, TLS connections, a filesystem, and a signing key — under a per-app
permission the user grants once, from a manifest the app declares.

So **the entire product is a privilege boundary.** A finding that says "a web page can open a
socket" is the feature. A finding that says "a web page can open a socket it was never granted",
or "app A reached app B's data", is the product failing.

The boundary runs: **page (untrusted) → preload (`src/preload/`) → broker (`src/broker/`) → OS.**
Everything a page can reach is `window.orivon`, built in `src/preload/orivon-surface.ts` and
`src/preload/main-world-socket.ts`. The broker is the only thing that touches real I/O, and it
decides every call by origin.

Read first, in this order:
- `docs/architecture/security-model.md` — the threat model, T1–T18+, and the intended answer to each.
- `docs/architecture/handle-contracts.md` — the lifetime/revocation rules every handle must obey.
- `docs/architecture/capability-api.md` — the product surface.
- `src/broker/README.md` — the five broker directories and what each may not import.

## 2. Known-open findings — please do NOT re-report these as new

Each is filed in `docs/open-questions.md` with a full write-up. **Deepening one is valuable;
rediscovering it is not.** Where you can show one is worse than the entry claims, that is exactly
the finding worth having.

| ID | What it is |
|---|---|
| A108 | A tab picks its storage partition from the URL typed, before fetching. A redirect to another origin keeps the ORIGINAL partition, so the landed-on site reads and writes the previous origin's storage. **The owner has ordered this fixed; it is not fixed at `fdb884a`.** |
| A112 | `fs.readFileSync` does not share the async path's per-origin in-flight budget. Grant check and path confinement ARE shared, so this is fairness, not confinement. |
| A113 | A thrown `OrivonError` loses its `code` crossing `contextBridge` on the `exposeFallback` path, so a page cannot branch on the closed error enum. |
| A114 | `net.listen` cannot reach a page: delivering accepted connections needs a nested-port IPC shape that does not exist. |
| A110 | `onHeadersReceived` never fires for a `protocol.handle`-served response in this Electron version — which is how CSP was meant to be enforced for cached bundles. |
| A107 | `dns.lookup` has no capability. The shim refuses loudly rather than resolving. |
| A106 | `net.listen`'s accept backpressure is a bounded fallback queue, not the OS mechanism the contract describes. |
| A109 | A cross-origin view swap discards navigation history, so Back cannot return past it. |

**Three more, found while building the install prompt and filed NOWHERE — they exist only in the
run's ledger. Please pick these up:**

1. **The origin in the consent prompt is rendered raw.** A consent dialog is precisely where a
   homograph / lookalike domain pays off, and nothing normalises or flags it.
2. **"and N other sites" has no cap.** At a large N the summary hides breadth — which is the exact
   failure the owner rejected a details-expander for.
3. **`manifest.ts` promises that an app which listens on a port gets "a distinct, more serious
   prompt". No such prompt exists.**

## 3. Deliberate decisions that will look like vulnerabilities

Each of these is an owner's decision with recorded reasoning. **Do not report them as flaws.**
Report anything that shows the *reasoning* is wrong, or that the implementation is wider than the
decision.

- **An app may set any request header on a granted host — including `Origin`, `Referer`,
  `User-Agent` and `Cookie`.** ADR-0017. Safe *because* these connections carry no ambient
  credentials: nothing rides the user's existing logins, the app must supply everything itself.
  **A finding that breaks that premise — anything showing a routed request picking up the user's
  own cookies or session — is critical and wanted.**
- **A manifest may declare unlimited HTTPS**, granted once at install with no per-host prompting.
  The mitigation is that breadth must be *visible* in the prompt, which is why finding 2 above
  matters.
- **A blanket `*:*` network grant deliberately does NOT reach mail, DNS, IRC or remote-access
  ports** unless a pattern names the exact port (A82). Verify the exclusion actually holds.
- **An app's simultaneous-socket allowance is declared in its manifest**, clamped, and enforced,
  with a modest default (A80).
- **Synchronous file reads block the renderer.** ADR-0016; the blocking is the point.
- **An uncaught main-process error logs and exits rather than showing a dialog.** Deliberate: a
  modal dialog keeps the process alive forever, which wrecked the developer's machine overnight.
- **`hid`/USB and `subprocess` are cut from v0 entirely.** Ambient filesystem access
  (`~/.bitcoin` and similar) is refused by design — `fs` is rooted per app, and the picker is a
  picker, not a mount.

## 4. What is not wired yet — do not spend effort here

- **`app.requestGrant` has no page-facing caller.** The mechanism, policy and prompt all exist;
  nothing calls them. So **no origin holds a grant in production**, and a page's `net.connect`
  answers `'denied'` for want of a grant rather than for want of enforcement. Any test needing a
  real grant must create one through the broker's own API, as the e2e tests do.
- `fs.open`/`FileHandle` is unbuilt, so `fs.userSelected` and the folder picker do not exist.
- `id.requestIdentity` is unbuilt, so `window.nostr` cannot be reached from a page.

## 5. Where the risk actually concentrates

The owner's own standing rule is that diffs touching `src/broker/` and `src/main/` get read
personally, because that is where mistakes have actually happened. Suggested weighting:

1. `src/broker/policy/` — every allow/deny decision. Pure functions, no I/O by design; a policy
   that reads the filesystem is itself a finding.
2. `src/broker/handles/` — lifetime, revocation, and the teardown cascade. Past defects here were
   real: a socket that survived revocation, a `close()` that never resolved.
3. `src/preload/` — the trust boundary itself, and `contextBridge`/`executeInMainWorld` use.
   A113 lives here.
4. `src/main/tabs.ts` and `window.ts` — partitions and tab identity. A108 lives here.
5. `src/loader/` — fetching and caching app code, and the bundle hash that pins it.

## 6. Verifying a claim

- `npm test` — unit tests (about 3,100).
- `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:e2e` — real Electron. **Both parts are
  mandatory:** `ELECTRON_RUN_AS_NODE=1` is set in this machine's shell and silently turns Electron
  into plain Node, and without `xvfb-run` a window lands on the owner's actual desktop.
  **Run only one Electron launch at a time.**
- `npm run check:secrets`, `check:natives`, `check:contracts`, `check:comments`, `check:size`.

## 7. What the owner wants out of this

Findings that are **real, reproducible, and ranked** — with the reproduction, not just the
reasoning. A proof-of-concept against a running build beats an argument from reading the source.
Where you are unsure, say so plainly and label it; a confident wrong finding costs more than an
honest maybe. Patches are welcome as files to review, never applied directly to `main` — the tree
is frozen deliberately.
