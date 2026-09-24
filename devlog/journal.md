# Devlog journal — running capture

This file is the raw material for the Sunday devlog. It is append-only during the
week and compiled by `/devlog` into `devlog/updates/YYYY-MM-DD.md`, after which the
compiled week is cleared and a fresh week heading is started.

Three buckets per week:

- **Done / results** — technical outcomes worth telling the team. One line each.
- **In my head** — what the owner has been thinking about: doubts, direction changes,
  things circling that are not visible in commits. These become the voice-note cues.
- **Non-repo** — calls, Notion work, admin, anything outside this repository. Claude
  cannot see these, so the owner jots them here (or they get a placeholder on Sunday).

Mark anything that must not leave the team draft as `(Keep private)`.

---

## Week of 2026-09-22

### Done / results

- Port method captured as the `orivon-porting` skill: triage, recon greps, five buckets, the escape test, two silent build traps.
- Ports split into `orivon-ports`: recipe-driven harness clones, builds and serves an app; FreeTube moved, 34 bridge tests green.
- Ports split merge dropped FreeTube's new datastore work: it never reached `orivon-ports`, and CI cannot see the gap.
- Routed `fetch` now carries the platform's descriptor: a locked one killed any app using a `fetch` ponyfill, and guarded nothing.
- Dock icon found to be a desktop-entry problem, not a window one: Electron's window `icon` never reaches X11 `_NET_WM_ICON` here (verified live, and Codium shows the same), so the fix is a `orivon.desktop` with `StartupWMClass=orivon` matching the WM_CLASS Electron already derives from the app name.
- `merge=union` is local only: GitHub ignores it, so append-only files show conflicts on a PR that `git merge` resolves silently here.
- Top-level `apps/` removed: fixture and demo moved to `test/apps/`, carved out of Rule 2's test-file definition so the guards still cover them.
- `src/main/` reorganised into nine job-named directories (ADR-0023), matching `src/broker/`'s own convention; tests and behaviour unchanged.
- Copy was broken on every website, not just apps: the gate now allows clipboard write, and dev `.eth` tabs are secure contexts.
- Page globals must now carry the platform's descriptor, guarded by a check; an app tab that dies on load finally says so.
- Headless ASGARDEX sweep, every screen: routed `fetch` crashed on `signal: null`, breaking SUI; fixed.
- ASGARDEX's SOL→RUNE "enable Thorchain" error is a live THORChain SOL halt, not Orivon: upstream's message misleads.
- Five ASGARDEX chains need API keys upstream bakes in from CI secrets; a port must bring its own.
- Platform-fidelity sweep fixed most of 86 audited gaps; XHR, EventSource and WebSocket now routed, installed apps survive restarts and updates.
- Owner allowed unsafe-eval and fullscreen, let '*' https grants reach any CDN, raised bundle caps to 64/512 MiB, and gave dev origins installed CSP.
- Routed `fetch` now waits for a socket past the app's allowance instead of failing: FreeTube's 100-subscription refresh went from 286 errors to none.
- Third port, AirGap Vault: zero preload, zero bridge -- but camera and clipboard read are denied everywhere, so it cannot receive anything to sign.
- Fourth port, Element Desktop: real login, pickle key and Rust crypto verified live against a local Synapse; OS-keyring secrets stay an orivon-mvp gap.
- Fixed OIDC logins losing state: a tab leaving an app now parks its view, so sessionStorage and history survive the provider round trip.
- DDOC ships as evidence: sites publish their bundle hash tree, the Web3 Score page shows verified, failed, or not published.
- orivon-ports now generates every port's assets list and hash tree; all five ports verify byte-for-byte against the shell.
- `vitalik.eth` loads in the real shell from mainnet: name proven by Helios, every IPFS block hashed locally, 2.8 s.
- Web3 Score page now leads with the Website level: verified `.eth` names reach Level 2; everything else stays Level 1.

### In my head

- Built the harness but not the bridge generator: with one port done it is tooling for a sample of one.
- Corrected: DDOC never needed trustless resolution; that belongs to the connection axis. Its same-host anchor stays provisional.
- Any web page can time a `.eth` request and learn which names were opened recently (A256); no fix is free.

### Non-repo
