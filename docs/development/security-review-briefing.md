# Security review briefing

For whoever, person or agent, is about to review this repository's privilege boundary. Read it
before the scan starts, not during.

## This document carries no finding list and no build status

A copied finding list goes stale within days, as findings are resolved and "do not spend effort
here" areas get built, and a stale briefing is worse than no briefing: it steers a reviewer away
from code that now exists and toward findings already filed. So both lists live where they are
re-derived from the tree rather than copied out of it.

| Before you report anything | Read |
|---|---|
| Is this already filed, and what happened to it? | [`../open-questions.md`](../open-questions.md), where every entry carries its status in its own heading: `[STILL OPEN]`, `[RESOLVED <date>]`, `[PARTIALLY RESOLVED <date>]`, `[AI-REC]`, `[NEEDS OWNER DECISION]` |
| Does this code path exist yet, and can a page actually reach it? | [`../planning/compatibility-matrix.md`](../planning/compatibility-matrix.md), scored in four columns, because **a module existing is not the same fact as a page being able to reach it** (A151) |

**Deepening a filed finding is valuable; rediscovering it is not.** Where you can show one is worse
than its entry claims, that is exactly the finding worth having.

## 1. What Orivon is, in the only terms that matter here

It is a browser that deliberately gives ordinary web pages what a browser normally refuses them:
raw TCP and UDP sockets, TLS connections, a filesystem, and a signing key, all under a per-app
permission the user grants once, from a manifest the app declares.

So **the entire product is a privilege boundary.** A finding that says "a web page can open a
socket" is the feature. A finding that says "a web page can open a socket it was never granted",
or "app A reached app B's data", is the product failing.

The boundary runs: **page (untrusted) → preload (`src/preload/`) → broker (`src/broker/`) → OS.**
Everything a page can reach is `window.orivon`, built in `src/preload/surface/orivon.ts` and
`src/preload/surface/main-world-socket.ts`. The broker is the only thing that touches real I/O, and it
decides every call by origin.

Read first, in this order:

- [`../architecture/security-model.md`](../architecture/security-model.md): the threat model and the intended answer to each threat. Cite threats by their `T<n>` number; deliberately not counted here, because the count moves.
- [`../architecture/handle-contracts.md`](../architecture/handle-contracts.md): the lifetime/revocation rules every handle must obey.
- [`../architecture/capability-api.md`](../architecture/capability-api.md): the product surface.
- [`../../src/broker/README.md`](../../src/broker/README.md): the five broker directories and what each may not import.

## 2. Deliberate decisions that will look like vulnerabilities

Each of these is a recorded design position with its reasoning written down. **Do not report
them as flaws.**
Report anything that shows the *reasoning* is wrong, or that the implementation is wider than the
decision.

- **An app may set any request header on a granted host, including `Origin`, `Referer`,
  `User-Agent` and `Cookie`.** ADR-0017. Safe *because* these connections carry no ambient
  credentials: nothing rides the user's existing logins, the app must supply everything itself.
  **A finding that breaks that premise, anything showing a routed request picking up the user's
  own cookies or session, is critical and wanted.**
- **A manifest may declare unlimited HTTPS**, granted once at install with no per-host prompting.
  The mitigation is that breadth must be *visible* in the prompt, so a finding that hides breadth
  from the prompt attacks the mitigation, not the decision.
- **A blanket `*:*` network grant deliberately does NOT reach mail, DNS, IRC or remote-access
  ports** unless a pattern names the exact port (A82). Verify the exclusion actually holds.
- **An app's simultaneous-socket allowance is declared in its manifest**, clamped, and enforced,
  with a modest default (A80).
- **Synchronous file reads block the renderer.** ADR-0016; the blocking is the point.
- **An uncaught main-process error logs and exits rather than showing a dialog.** Deliberate: a
  modal dialog keeps the process alive forever, which wrecked the developer's machine overnight.
- **`hid`/USB and `subprocess` are cut from v0 entirely.** Ambient filesystem access
  (`~/.bitcoin` and similar) is refused by design: `fs` is rooted per app, and the picker is a
  picker, not a mount.

## 3. Where the risk actually concentrates

The owner's own standing rule is that diffs touching `src/broker/` and `src/main/` get read
personally, because that is where mistakes have actually happened. Suggested weighting:

1. `src/broker/policy/`: every allow/deny decision. Pure functions, no I/O by design; a policy
   that reads the filesystem is itself a finding.
2. `src/broker/handles/`: lifetime, revocation, and the teardown cascade. Past defects here were
   real: a socket that survived revocation, a `close()` that never resolved.
3. `src/broker/grants/`: what is remembered across restarts, and for which origin.
4. `src/preload/`: the trust boundary itself, and `contextBridge`/`executeInMainWorld` use.
5. `src/main/shell/tabs.ts` and `window.ts`: partitions and tab identity.
6. `src/loader/`: fetching and caching app code, and the bundle hash that pins it.

## 4. Verifying a claim

- `npm test`: unit tests (about 3,100).
- `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:e2e`: real Electron. **Both parts are
  mandatory:** `ELECTRON_RUN_AS_NODE=1` is set in this machine's shell and silently turns Electron
  into plain Node, and without `xvfb-run` a window lands on the owner's actual desktop.
  **Run only one Electron launch at a time.**
- `npm run check:secrets`, `check:natives`, `check:contracts`, `check:comments`, `check:size`.

## 5. What the owner wants out of this

Findings that are **real, reproducible, and ranked**, with the reproduction rather than just the
reasoning. A proof-of-concept against a running build beats an argument from reading the source.
Where you are unsure, say so plainly and label it; a confident wrong finding costs more than an
honest maybe.

**Patches are welcome as files to review, never applied directly to `main`.** If you need the tree
to hold still for a scan, ask for a freeze with an **explicit end condition**, and say which commit
you bound to. A freeze with neither parks finished work long after its reason is spent.
