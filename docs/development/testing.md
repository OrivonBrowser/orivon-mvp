# Testing

## Read this first, because the test suite looks neglected and is not

There are no coverage targets and a deliberately small number of unit tests, and the UI is
covered by an end-to-end suite that drives the real shell (§Visual QA and failure evidence). The
small unit count is a decision, not a backlog ([`build-plan.md`](../planning/build-plan.md)
§Testing).

The reasoning: this is a browser built by one person, and at that scale broad test suites
cost more than they return: they are written once, then maintained forever, against code that
is still changing shape weekly. So testing is **concentrated where a silent failure is both
plausible and expensive**, and absent everywhere else.

The concentration is not arbitrary. Every area listed below has the same property: **its
failure mode is silence.** A broken capability check does not throw; the app just works, with
more authority than the user granted. That is the class of bug a person cannot catch by using
the product, and it is exactly the class this project is about.

Where a bug is loud (the window does not open, the tab does not switch) a person notices in
seconds, and a test would be paying rent to tell you something you already know.

## How to run

| Command | What |
|---|---|
| `npm run typecheck` | `tsc --noEmit`. Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, so the compiler is doing a lot of the work a test suite would elsewhere. `tsconfig.json`'s `include` covers `test/**/*.ts`, so this also type-checks `test/e2e-capability-boundary.test.ts`, and a type error there fails this always-on check even on a push that never runs the separate `e2e` job below |
| `npm test` | Vitest. `environment: 'node'`, no DOM. Picks up `src/**/*.test.ts` and `scripts/**/*.test.ts` |
| `npm run smoke` | Builds and drives the real shell with real clicks. The only check that proves a window appears |
| `npm run test:e2e` | Builds, then runs [`test/e2e-capability-boundary.test.ts`](../../test/e2e-capability-boundary.test.ts) (TCP) and [`test/e2e-udp-capability.test.ts`](../../test/e2e-udp-capability.test.ts) (UDP) via [`test/vitest.e2e.config.ts`](../../test/vitest.e2e.config.ts); see §The end-to-end test below. Runs automatically in CI's `e2e` job on every push and pull request. Needs a display; on Linux with `xvfb-run` installed it uses a virtual one automatically (see [setup.md](setup.md) "The no-focus switch"), so a plain `npm run test:e2e` is safe with no wrapper, and on a platform with no virtual display it runs directly instead, without stealing your keyboard focus |
| `npm run qa` · `qa:visual` · `qa:report` | The QA specs and the inspection sheet; §Visual QA and failure evidence |

Unit tests are **colocated** with what they test: `src/main/tests/omnibox.test.ts` sits beside
`src/main/browsing/omnibox.ts`.

### What `npm run smoke` is, and what it is not

It is the **shell's** regression check, a different thing from the unit tests below, held to a
different bar. §The six security-critical areas argues for testing only where failure is
*silent*; that argument governs the unit tests. `smoke.mjs` also asserts loud things (a window
opens, the back button works), on purpose: it launches the real app either way, so the extra
assertions are nearly free once the launch is paid for.

Three properties it is required to keep:

- **It reports, it does not just exit.** It prints a JSON result and a failure list. **Read
  those, not the exit code alone.** A thrown error is recorded as a failed check rather than
  replacing the output, and every click is bounded, so a broken run still tells you what broke.
- **It is hermetic, structurally.** It launches Electron with
  `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`: nothing but loopback resolves, so
  it passes air-gapped and a change that made it depend on the network fails loudly instead of
  quietly phoning out. Deliberately a whole-world blackhole rather than a per-host one: a
  per-host rule only protects the host somebody thought of.
- **It waits for conditions, never for the clock, except when asserting an absence.** Fixed
  sleeps make a slow machine report a harness race as a product bug. But `waitFor` returns the
  instant its predicate holds, so **it must never be pointed at a condition the pre-action state
  already satisfies**: that is a no-op that reports green. Two checks were written that way and
  both passed while the exact regression they existed to catch was present. Either establish an
  observable *transition* first, or settle and read once. And a refusal, a navigation that must
  *not* happen, cannot be polled for at all; only waited out.

It is **not** an end-to-end test of the capability stack; that is the separate one described in
§The end-to-end test.

---

## The six security-critical areas

Each is a pure function tested against stubs. This is why
[`src/broker/policy/`](../../src/broker/policy/) may not import `electron` or perform I/O:
that constraint is what makes these tests cheap enough to actually exist.

### 1. Capability checking at the call site

`checkConnect(patterns, hostArg, port, resolveFn)` with an **injected stub resolver**, not just
the pattern matcher in isolation. `patterns` is the **GRANTED** `readonly Pattern[]`, not a
`Manifest` (A18).

> **Both halves of that signature are load-bearing.** `port` is there because a connect pattern
> is `host:port`, so the port is half the decision and the function cannot make it without one.
> `readonly Pattern[]` is there because the patterns the user actually **granted** are already
> narrowed by the caller, and are not the wider set the manifest merely **declared**.

*Why the distinction matters:* a perfectly correct glob matcher, fed a **hostname**, is still
completely defeated by DNS rebinding (T12). Testing the matcher alone covers the harmless half
of the threat. Patterns must be checked against **resolved addresses**.

Plus an `isPublicUnicast` table covering `127/8`, `10/8`, `172.16/12`, `192.168/16`,
`169.254/16`, `::1`, `fc00::/7`, IPv4-mapped `::ffff:127.0.0.1`, and integer and octal literal
forms.

### 2. `fs` path-traversal rejection

`path.relative(root, resolved)` must be non-empty, must not start with `..`, and must not be
absolute, **plus `realpath` on the parent**, so a planted symlink cannot escape.

*Why both:* a string-prefix check passes `/apps/foo-evil` against root `/apps/foo`, and
`path.resolve` does not follow symlinks.

Table: `..`, absolute paths, symlink escape, NUL bytes, sibling-prefix, Windows separators and
drive letters, `\\?\` UNC, reserved names, macOS case-insensitivity. One `fast-check` property:
for random segment arrays, the resolved path is always inside root.

**This is also a torrent client's happy path.** A `.torrent` file declares its own file paths, and
`../../../.ssh/authorized_keys` is a real BitTorrent CVE class. T1 and T10 combine here.

### 3. Origin derivation, split in two

1. **URL → origin normalisation:** default ports, trailing dots, case, punycode/IDN, userinfo,
   and rejection of `file:` and `data:`.
2. **`senderFrame` → origin:** asserting that an origin field **in the IPC payload** is
   ignored, that `url` and `frame.origin` must **agree** or the frame is denied, that an
   **opaque** origin (`frame.origin === 'null'`, what a `CSP: sandbox` document reports) is
   rejected outright, and that unbound frames are rejected (T3, T13b).

   *"An origin field in the IPC payload" does not mean `WebFrameMain.origin`, which Electron
   computes in the browser process. Reading only `url` and ignoring `frame.origin` opens a real
   hole; `security-model.md`'s note on why the T3 mitigation reads both `url` and `origin` has
   the cases.*

### 4. Key derivation as frozen golden vectors

Hardcoded seed / origin / curve → expected public key hex, for both the `"app"` and
`"identity"` labels, asserting the two differ.

*Not* a determinism test: same-input-same-output is near-tautological for a KDF. The real risk
is the derivation **changing between releases** and silently orphaning every user's identity,
with no export path to recover from ([`ADR-0003`](../decisions/ADR-0003-local-first-storage.md)).

### 5. The update decision table

`decideUpdate({pinnedHash, newHash, grantedPatterns, newPatterns, version, versionFloor})`
→ `'silent' | 'reconsent' | 'capability-prompt' | 'reject'`, about eight rows.

*Why:* its failure mode is **"no prompt appeared"**, which no manual checklist catches, and the
capability at stake is `tcp.connect *:*`.

### 6. Telemetry session accounting

A pure fold over an event stream: start/stop, suspend/resume, tab switch, **active vs
background attribution**, month rollover, abnormal termination (assert a periodic checkpoint,
so a crash loses minutes rather than a session).

*Why:* this is the number the project is judged on, and its likeliest bug **biases it
downward**, making a succeeding product look like a failing one.

---

## The end-to-end test

**One test, covering four of the five critical-path layers in a single launch:**

fixture app served over localhost HTTP with a real `/.well-known/orivon.json` → loaded via the
app loader → grant accepted → `require('net')` **through the shim** connects to a local echo
server and moves bytes → **then the same app attempts a connection outside its manifest
patterns and is rejected.**

**That last clause is the highest-value assertion in the entire plan.** Without it, *nothing
fails if capability enforcement degrades to allow-all*: the unit tests check the matcher in
isolation, the e2e would test only the allow path, and every user journey is a happy path. A
broker regression that skipped the check entirely would pass every test while the product
appeared to work perfectly. Do not drop it.

**It lives in [`test/e2e-app-loader-journey.test.ts`](../../test/e2e-app-loader-journey.test.ts)**,
and the refusal goes through the real shim (`src/shim/net/net.ts`), not only the raw capability
API. One link is substituted, and the file's header says exactly where: the fixture is served
from loopback, and [`install-origin.ts`](../../src/loader/fetch/install-origin.ts) refuses a loopback
origin outright (A46), so no install can succeed. The real `<link rel="orivon-manifest">` hint is
proven to reach the real listener and take the grant-without-install path instead; the granted
round trip is enabled separately, through `src/main/dev/dev-grant.ts`'s developer-only hook,
acting on the same broker the launched shell's IPC uses. That path
(`src/main/install/grant-without-install.ts`, loopback in every build) has its own test, on an
ordinary build with no developer mode,
[`test/e2e-loopback-grant.test.ts`](../../test/e2e-loopback-grant.test.ts). `ORIVON_DEV_ORIGINS=1`,
paired with `ORIVON_ETH_NAMES_FILE`, turns on the fake `.eth` names
(`src/main/dev/eth-resolver.ts`) and grants them the same way -- both halves are covered in
[`test/e2e-eth-secure-context.test.ts`](../../test/e2e-eth-secure-context.test.ts), which asserts
a `.eth` tab is a secure context and so keeps `crypto.subtle`, `crypto.randomUUID`, service
workers and `navigator.clipboard`. See [setup.md](setup.md) for what the two variables do. Consent gating itself is proven separately, in
[`test/e2e-install-consent-journey.test.ts`](../../test/e2e-install-consent-journey.test.ts).

The raw capability API has its own boundary suites, one file per transport, because Rule 2 caps
a test at 800 lines: [`e2e-capability-boundary.test.ts`](../../test/e2e-capability-boundary.test.ts)
(TCP: `net.connect`, byte round trip, out-of-pattern denial) and `e2e-udp-capability.test.ts`
(UDP: `net.udpBind`, datagram round trip, out-of-pattern refusal, and the two properties UDP has
that TCP does not: a refused datagram must not kill the socket, and revoking `udp.send` must stop
the *next datagram* on an already-bound socket). The shared harness (the fixture-server
children, the address-bar navigation dance, the per-phase reporter) lives in
[`test/e2e-helpers.ts`](../../test/e2e-helpers.ts).

These suites cover what an app's page is served with, what it may put inside itself and what it may serve:
[`e2e-embed.test.ts`](../../test/e2e-embed.test.ts) drives a `<webview>` under a `web.embed`
grant (the shown site loads in the app's own embed partition with no `orivon.*`, the app's
script runs first under a strict page CSP and talks to the element both ways, a site outside
the grant and a `file:` URL are refused, an ordinary tab's element is inert, and a revoke closes
the page), [`e2e-embed-local.test.ts`](../../test/e2e-embed-local.test.ts) serves pages from the
app's own loopback listener under a local pattern (two labels are two origins, a cookie does not
cross them, a page is refused while the app holds no listener or another program holds the
port, a server the test holds on `[::1]` at the app's port is never the one shown, and a shown
page closes with the app's listener), [`e2e-embed-events.test.ts`](../../test/e2e-embed-events.test.ts) drives a shown page's
popups, downloads and a link to an unknown scheme with real input and reads the events on the
element, [`e2e-http-server.test.ts`](../../test/e2e-http-server.test.ts) runs `http.createServer`
in a page and answers real requests from outside the browser,
and [`e2e-wasm-threads.test.ts`](../../test/e2e-wasm-threads.test.ts) pins one bundle
declaring `crossOriginIsolated` and one without, and measures `SharedArrayBuffer`, a shared
`WebAssembly.Memory` and `Atomics.wait` in a worker in each.

[`e2e-wasi-host.test.ts`](../../test/e2e-wasi-host.test.ts) pins an app whose page runs a WASI
program through Node's `wasi` module: its file calls reach the real broker through JSPI, the bytes
it wrote are read back through `orivon.fs`, and its attempt to leave its preopen comes back
`NOTCAPABLE`. The WASI host also has an opt-in conformance run against the official preview1
suite, [`src/shim/wasi/tests/conformance.test.ts`](../../src/shim/wasi/tests/conformance.test.ts),
which skips unless `ORIVON_WASI_TESTSUITE` names a checkout of the suite's prebuilt branch; the
suite's binaries are not in this repository.
[`e2e-child-process.test.ts`](../../test/e2e-child-process.test.ts) runs `child_process` in a pinned
app: `spawn` of a WASI program and `fork` of the app's own module, each in a Worker under the served
CSP, the forked module's `fs` write read back through the broker, a native program refused as
`ENOEXEC`, a missing one `ENOENT`, and `kill()` ending a running child.
[`e2e-native-addon.test.ts`](../../test/e2e-native-addon.test.ts) loads a hand-assembled Node-API
module as a native addon's WebAssembly build: through `createRequire` and `process.dlopen` on the
page, through `preloadAddon` for one over the page's 8 MB synchronous-compile limit, and on the fly
in a forked child.
[`e2e-napi-rs-package.test.ts`](../../test/e2e-napi-rs-package.test.ts) runs a napi-rs package's
published WebAssembly build, which is threaded, through the package's own browser loader in a
cross-origin isolated app. It skips unless `ORIVON_NAPI_RS_PACKAGE_DIR` names a directory the
package was installed in, since the package is not one of this repository's. Real programs and
addons built outside the repository run against the WASI and addon hosts in opt-in unit tests the
same way: `ORIVON_WASIP2_STD_PROGRAM`, `ORIVON_WASIP2_TOKIO_PROGRAM` and `ORIVON_NAPI_RS_ADDON`,
each test's header naming what to build.

[`e2e-the-lounge-real.test.ts`](../../test/e2e-the-lounge-real.test.ts) runs The Lounge's upstream server,
unmodified, in a forked Worker of an app (the real consent prompt, the launcher creating the account with
upstream's own command, the server on `127.0.0.1:9000`, its page in a `<webview>`) against
[`irc-fake-server.mjs`](../../test/irc-fake-server.mjs): a network connect, messages both ways, a link opening
a tab, the scrollback read back from SQLite after a relaunch on the same profile, and a second tab finding the
port held. It skips unless `orivon-ports` (`ORIVON_PORTS_ROOT`, default the sibling checkout) holds the
built app, and unless the build is the ordinary one (`ORIVON_ORDINARY_BUILD=1`), as `e2e-freetube-real`
does; it binds 9000 and 6667. The server's release check may reach `api.github.com` from the main process
(`--host-resolver-rules` does not cover it); no assertion depends on the answer.

**They run automatically.** `npm run test:e2e` runs every `test/**/*.test.ts` outside `test/apps/` under
`test/vitest.e2e.config.ts`, and `.github/workflows/ci.yml`'s `e2e` job runs it on every push and
pull request (see §How to run above).

### Playwright's `_electron` driver and this shell

The end-to-end tests drive the shell through Playwright's `_electron` library. It attaches
cleanly to a `BaseWindow` holding several `WebContentsView`s, which is this shell's composition,
and the `e2e` job is green on GitHub-hosted `ubuntu-latest` runners for both the `push` and
`pull_request` events. Match windows by URL through `app.windows()`, never
`app.firstWindow()`: view-add order is not a contract (`scripts/smoke.mjs` has the pattern).

The driver does fail to attach to one window, spike gate 3's, for a cause still unidentified
([`open-questions.md`](../open-questions.md) C6). The app itself works there, confirmed by a
direct launch without Playwright, and the failure is specific to that gate's video and
service-worker setup, not to `BaseWindow` in general.

### Checking against real Chrome extensions

[`test/e2e-extensions-real.test.ts`](../../test/e2e-extensions-real.test.ts) installs whichever
of uBlock Origin Lite, Dark Reader, Bitwarden and MetaMask it finds unpacked in
`ORIVON_REAL_EXTENSIONS_DIR` (one subdirectory per extension, named `ubol`/`darkreader`/
`bitwarden`/`metamask`) through the real install path, then records per extension: whether its
service worker is still running 10s after load and its first console errors, whether its
toolbar action popup renders a non-empty body, and one SW-independent behaviour each (MetaMask's
`window.ethereum`, Bitwarden's content-script response, Dark Reader's injected style, uBOL's
popup). It is skipped entirely with no directory set, so `npm run test:e2e` never runs it. Run it
directly:

```
ORIVON_REAL_EXTENSIONS_DIR=/path/to/extracted node scripts/build-e2e.mjs && \
  node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-extensions-real.test.ts
```

Re-download each extension's latest release from its own GitHub releases page when the directory
is missing or stale; never commit the extracted folders. Run sandboxed (`launchElectron`'s
`sandbox: true`) -- under `--no-sandbox`, [`open-questions.md`](../open-questions.md) A289's cause
makes every service-worker-dependent check fail, which is not a sign this file is broken.

---

## Visual QA and failure evidence

The e2e suite also carries a layer for what a person would see, and for what a failed spec leaves
behind. The [`orivon-qa`](../../.claude/skills/orivon-qa/SKILL.md) skill is the working procedure;
this section is the reference.

**Commands.** `npm run qa` runs the QA specs and writes the inspection sheet; `npm run qa:visual`
runs only the visual ones; `npm run qa:report` rebuilds `qa-artifacts/latest/inspect.md` from the
last run. All three launch Electron headless, like `test:e2e`.

| Spec | Proves |
|---|---|
| [`e2e-qa-audit`](../../test/e2e-qa-audit.test.ts) | Every layout-audit rule fires on a page broken on purpose, and none on a clean one |
| [`e2e-qa-visual`](../../test/e2e-qa-visual.test.ts) | Eleven shell states: layout audit clean, no shell errors, something painted, and under `qa` the pixel baseline matched |
| [`e2e-qa-journey`](../../test/e2e-qa-journey.test.ts) | A bookmark starred in the toolbar is on disk, survives a relaunch on the same profile, and so does removing it |
| [`e2e-qa-adversarial`](../../test/e2e-qa-adversarial.test.ts) | Corrupt profile files, tab churn, a killed renderer and an abandoned load leave the shell working and consistent |
| [`e2e-qa-evidence`](../../test/e2e-qa-evidence.test.ts) | The failure bundle holds what the page logged and threw, a dead renderer, the main log and real pixels |

**Failure evidence, for every e2e spec.** [`launch-electron.mjs`](../../test/launch-electron.mjs)
starts recording each launched app ([`qa-evidence.mjs`](../../test/qa-evidence.mjs)) and, at close,
snapshots its final state. [`qa-setup.ts`](../../test/qa-setup.ts), a Vitest setup file, writes that
snapshot only if the test failed, and drops it otherwise. A failed spec leaves
`qa-artifacts/latest/<spec>/<test>/` (gitignored; linked from `qa-artifacts/latest/index.md`):

```
summary.md                     the error, and a line per launch
launch-N/screenshots/          one PNG per shown view, and window-0-composite.png
launch-N/aria/  dom/           the accessibility tree and the redacted DOM of every page
launch-N/console.json          warnings and errors the pages logged
launch-N/page-errors.json      uncaught page errors, with stacks
launch-N/failed-requests.json  requests that failed, with the reason
launch-N/crashes.json  main-events.json  main.log
launch-N/trace.zip             only with ORIVON_QA_TRACE=1
```

CI uploads `qa-artifacts/latest/` when the `e2e` job fails. Collection runs under Vitest, where the
setup file can write it; `ORIVON_QA_EVIDENCE=on` asks for it in a plain script and `off` turns it off. Typed values in password inputs are dropped from the DOM dump; the profile is a
throwaway and the network is blackholed, so nothing else sensitive is written.

**The layout audit** ([`qa-layout-audit.mjs`](../../test/qa-layout-audit.mjs)) runs inside each
shown shell view and reports: content outside the viewport, clipped text, a control covered by
another element, a zero-size control, unexpected scrolling, a broken image or empty icon, a modal
that is off-centre or outside the window, and `disabled` disagreeing with `aria-disabled`. An
intended case is allowlisted in the spec with a written reason. A control hidden by `opacity` is
not audited, because hover-revealed buttons make that mostly intended.

**Pixel baselines** are machine-local, in `$XDG_CACHE_HOME/orivon-qa/baselines/<platform>/`
(`ORIVON_QA_BASELINES` overrides), shared by every worktree on the machine and never committed.
The comparison runs only under `npm run qa` and `qa:visual` (they set `ORIVON_QA_PIXELS=1`), so an
ordinary `npm run test:e2e` never fails on a baseline that belongs to one machine, and `CI=true`
skips it as well. The first run records each; `ORIVON_QA_UPDATE_BASELINES=1` re-records after an
intended change, once the new screenshot has been looked at. A baseline only means something on the
machine and fonts that made it. The tolerance is 0.005% of the window,
about 50 pixels: an unchanged state measures 0.000%, and growing the tab titles by one pixel moves
0.02% or more, so anything looser misses a real change. A region that legitimately changes is
masked in the spec (`ignore`), never covered by a looser tolerance.

**Reading the states.** `qa:report` lists each captured state with what it should show, what the
deterministic checks found and a blank Verdict. A reader looks at the PNG and fills it in:
`expected-variation`, `harmless`, `defect`, `functional-bug` or `needs-human-review`. The
deterministic checks already fail the spec; the reading is for what they cannot see, and a state
is judged right only on positive evidence that it shows what it should.

**Limits.** A question is drawn in the question panel, an overlay page: a spec reads and presses its real
buttons (`test/question-support.ts`) and records the native boxes opened, which must be none. Leave this
page is still a native box, so the specs replace it. `capturePage()` fails without a GPU, so captures go through Playwright's own
screenshot of each view (measured behaviour in the `orivon-electron` skill). An uncaught exception
in the main process raises a blocking error dialog, so no spec provokes one. Malformed calls to
`window.orivon.*` are not covered yet.

## Guards

Thirteen checks that are not tests but fail the build the same way. Each is `npm run check:<name>`,
and CI's `check` job runs all of them; [`../../scripts/README.md`](../../scripts/README.md) says
what each one enforces.

`check:natives` · `check:contracts` · `check:secrets` · `check:vectors` · `check:comments` ·
`check:size` · `check:questions` · `check:manifest-parity` · `check:page-globals` ·
`check:dev-grant-absent` · `check:advisories` · `check:devlog` · `check:native-dialogs`

Every one is an exported pure function over a root directory, unit tested in
`scripts/tests/` against temp fixtures, with a CLI block guarded by `isInvokedDirectly` so the
test can import it without running it. Follow that shape if you add another, and add the CI step
in the same change: `scripts/tests/check-scripts-in-ci.test.ts` fails the unit suite if a
`check:*` script exists with no step to run it.

A guard imports `node:*` builtins and nothing from `src/` -- one that depended on the code it
guards could be disabled by the change it exists to catch.

---

## The manual checklist

[`release-checklist.md`](release-checklist.md) is run before each release. It includes
**run-from-source on Windows and macOS**, because that is a supported path that nothing in CI
exercises and it is the one most likely to break silently.

---

## CI

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on every push and pull
request: `npm ci` (which fires the Rule 8 guard via `postinstall`), typecheck, unit tests,
`check:natives`, `check:contracts`, build, plus a separate `e2e` job, also on every push and
pull request, that builds the real app and runs §The end-to-end test's `npm run test:e2e` under
`xvfb-run` (no display server on `ubuntu-latest` otherwise). Kept separate from the job above: it
needs a real Electron build and a display server, takes far longer than the unit suite, and a
failure there means something different, namely that the capability boundary itself broke, so it reads as
its own red X. When it fails, the job uploads `qa-artifacts/latest/` (§Visual QA and failure evidence).

**With no dedicated code reviewer, CI is the reviewer.** A red pull request does not merge.
