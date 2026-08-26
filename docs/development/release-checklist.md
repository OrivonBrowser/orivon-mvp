# Release checklist

Run before every release.

**Why this file exists.** [`mvp-scope.md`](../mvp-scope.md) describes the user journeys as
prose, and prose cannot be run identically twice — two people reading "paste a magnet link"
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

Have a way to observe outbound network traffic before launching — a proxy, `tcpdump`, or the
devtools network panel. **Reading the source is not sufficient for the last assertion.**

**Input.** Launch the app for the first time.

**Assertions.** All five must hold:

1. The disclosure screen appears **before** any other UI is usable.
2. It shows the **literal JSON** that would be sent — not a description of it, not a summary.
3. There are exactly **two buttons**, of **visually equal weight**. Neither is styled as the
   preferred action.
4. **Neither is preselected**, and no keyboard default activates one.
5. **Nothing has been transmitted** at the moment the screen is displayed. Verified from the
   traffic observation, not from the code.

**Fails if:** the JSON is summarised, one button is visually dominant, a choice is preselected,
or a single request leaves the machine before the user chooses.

---

## 2. Launch with no keyring available

Linux `safeStorage` needs an available keyring, and `isEncryptionAvailable()` returns false
otherwise. The failure mode this catches is a **silent downgrade to plaintext**
([`security-model.md`](../architecture/security-model.md)).

**Precondition.** A clean profile, and a launch that forces the basic password store:

```bash
npm start -- --password-store=basic
```

**Input.** Launch, then create or use an identity — anything that causes the seed to be
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

**Precondition.** A machine with **no C++ toolchain installed** — no Visual Studio Build Tools
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
`check:natives` has a gap — fix the guard as well as the dependency.

---

## 4. The shell smoke check

**Precondition.** A clean build.

**Input.**

```bash
npm run smoke
```

**Assertions.** All reported checks pass, and the `leakChecks` section shows `require` and
`process` as `undefined` in **every** renderer listed.

**Read the JSON output and the failure list — not the exit code alone.**

**Fails if:** any renderer leaks `require` or `process`. That is a `contextIsolation` /
`sandbox` regression ([`security-model.md`](../architecture/security-model.md) T17) and it is a
stop-everything result, not a bug to file.

---

## Scheduled additions

Written when the artefacts they depend on exist. Recorded here so the gap is known rather than
forgotten.

| Item | Added at | What it needs first, and why |
|---|---|---|
| **Journey 2 — the app from a URL** | build step 4 | The app loader, plus the torrent app served from a **second origin**. Journey 1 runs a pre-cached app and journey 4 loads a local directory, so without this **no journey demonstrates URL delivery** — which is the thesis |
| **Journey 1 — the clip** | build step 5 | A **named, pinned, well-seeded MP4/H.264 torrent**, recorded here by name. Not "a magnet link": with an unpinned torrent, pass/fail tracks that day's swarm health rather than the code. Assertion: video playing in **under 30 seconds** from a cold start, with the grant prompt shown |
| **Journey 3 — the identity** | build step 7 | **Three Nostr clients, pinned at a version**, named here. Assertion: the displayed npub is **byte-identical across two of them**. That is the check which would have caught the per-origin-key contradiction ([`open-questions.md`](../open-questions.md) B4) |

---

## Before tagging a release

- [ ] Every item above passes.
- [ ] `npm run typecheck && npm test && npm run check:natives && npm run check:contracts` green.
- [ ] CI green on `main`.
- [ ] [`CHANGELOG.md`](../../CHANGELOG.md) updated.
- [ ] Known limitations stated **in-product**, not only in the README: MP4/H.264 only; swarm
      peers see the user's IP; reduced seeding behind NAT; address-bar search text goes to
      DuckDuckGo.
- [ ] **Telemetry pre-announced.** Launch-blocking ([`readiness.md`](../planning/readiness.md)
      risk 5): telemetry discovered rather than announced is cheap to avoid and expensive to
      mishandle.
