# Release checklist

Run before every release.

**Why this file exists.** [`mvp-scope.md`](../mvp-scope.md) describes the user journeys as
prose, and prose cannot be run identically twice: two people reading "paste a magnet link"
test two different things, and the same person tests something different next month. Every item
here therefore has a **precondition**, a **fixed input**, and a **falsifiable assertion**.

**This document is deliberately incomplete.** Three items depend on artefacts that do not exist
yet; they are scheduled at the bottom rather than written as placeholders.

---

## 1. Telemetry first-run disclosure

The one item where getting it wrong is a reputational event rather than a bug
([`ADR-0004`](../decisions/ADR-0004-telemetry.md)).

**Precondition.** A clean profile. Delete the `userData` directory:

```bash
rm -rf ~/.config/orivon        # Linux; use app.getPath('userData') on other platforms
```

Have a way to observe outbound network traffic before launching: a proxy, `tcpdump`, or the
devtools network panel. **Reading the source is not sufficient for the last assertion.**

**Input.** Launch the app for the first time.

**Assertions.** All four must hold:

1. The disclosure screen appears **before** any other UI is usable.
2. It shows the **literal JSON** that would be sent, not a description of it, not a summary.
3. **Neither is preselected**, and no keyboard default activates one.
4. **Nothing has been transmitted** at the moment the screen is displayed. Verified from the
   traffic observation, not from the code.

**Fails if:** the JSON is summarised, a choice is preselected, or a single request leaves the
machine before the user chooses.

---

## 2. Launch with no keyring available

Linux `safeStorage` needs an available keyring, and `isEncryptionAvailable()` returns false
otherwise. The failure mode this catches is a **silent downgrade to plaintext**
([`security-model.md`](../architecture/security-model.md)).

**Precondition.** A clean profile, and a launch that forces the basic password store:

```bash
npm start -- --password-store=basic
```

**Input.** Launch, then create or use an identity: anything that causes the seed to be
persisted.

**Assertions.**

1. The app starts and does not crash.
2. **The seed is never written in plaintext.** Grep the `userData` directory for any part of
   it. Nothing.
3. The user is **told**, in the interface, that secure storage is unavailable and what that
   means. A silent downgrade is the failure being tested for.
4. The documented fallback behaves as documented.

**Fails if:** the seed appears in plaintext anywhere on disk, or the degradation happens
without the user being told.

---

## 3. Run from source on Windows and macOS

**The supported path most likely to break silently, because nothing in CI exercises it.** Both
platforms are supported from day one via run-from-source rather than signed installers
([`build-plan.md`](../planning/build-plan.md) §Platform policy), and those users count toward
the success metric.

**Precondition.** A machine with **no C++ toolchain installed**: no Visual Studio Build Tools
on Windows, no Xcode command-line tools beyond git on macOS. A machine that already has them
cannot perform this test, because it will succeed for the wrong reason.

**Input.**

```bash
git clone https://github.com/OrivonBrowser/orivon-mvp.git
cd orivon-mvp
npm install
npm start
```

**Assertions.**

1. `npm install` completes **without invoking a compiler**. No `node-gyp`, no `cmake-js`, no
   prompt to install build tools. The `postinstall` guard prints *"Rule 8 satisfied"*.
2. A window appears.
3. Basic browsing works: navigate, new tab, switch tab, back/forward.
4. Telemetry behaves **identically to Linux**, including the first-run screen above.
5. Storage lands in the platform's own `userData` location, not a hardcoded path
   ([`ADR-0003`](../decisions/ADR-0003-local-first-storage.md)).

**Fails if:** `npm install` needs any compiler at all. That is a Rule 8 violation and it means
`check:natives` has a gap; fix the guard as well as the dependency.

---

## 4. The shell smoke check

**Precondition.** A clean build.

**Input.**

```bash
npm run smoke
```

**Assertions.** All reported checks pass, and the `leakChecks` section shows `require` and
`process` as `undefined` in **every** renderer listed.

**Read the JSON output and the failure list, not the exit code alone.**

**Fails if:** any renderer leaks `require` or `process`. That is a `contextIsolation` /
`sandbox` regression ([`security-model.md`](../architecture/security-model.md) T17) and it is a
stop-everything result, not a bug to file.

---

## Scheduled additions

Written when the artefacts they depend on exist. Recorded here so the gap is known rather than
forgotten.

| Item | Added at | What it needs first, and why |
|---|---|---|
| **Journey 2: the app from a URL** | build step 4 | The app loader, and an app served from a **public https origin**, so the run goes through discovery, fetch, pinning and the one consent dialog rather than a developer-mode shortcut. Assertion: after accepting, the app's granted call succeeds, and a reload with the network unplugged is served from cache |
| **Journey 1: a desktop app, from a URL** | build step 5 | **One named port from `orivon-ports`, pinned at its recipe commit**, recorded here by name, and served from a public https origin: a developer-mode origin is never installed (`ADR-0029`). Not "a ported app": with an unpinned upstream, pass/fail tracks that day's commit rather than the code. Assertion: the app's main screen loads and one action that needs its granted network access succeeds, with the consent dialog shown |
| **Journey 3: a name on Ethereum** | build step 6 | **A named `.eth` name whose record is an `ipfs://` contenthash**, recorded here. Assertion: the page renders and the site-info popover shows the name proved and the content verified. Then a second run through a gateway that alters one block: it **must fail rather than render** |

---

## Before tagging a release

- [ ] Every item above passes.
- [ ] **The `.eth` light client's checkpoint refreshed and committed**:
      `node scripts/refresh-eth-checkpoint.mjs --write`. A release whose checkpoint is over 14 days
      old verifies no `.eth` name until the person installs a newer one.
- [ ] `npm run typecheck && npm test && npm run check:natives && npm run check:contracts` green.
- [ ] CI green on `main`.
- [ ] [`CHANGELOG.md`](../../CHANGELOG.md) updated.
- [ ] Known limitations stated **in-product**, not only in the README: peers see the user's IP;
      no automatic port forwarding behind NAT; address-bar search text goes to DuckDuckGo.
- [ ] **Telemetry pre-announced.** Launch-blocking ([`readiness.md`](../planning/readiness.md)
      risk 5): telemetry discovered rather than announced is cheap to avoid and expensive to
      mishandle.
