# Release checklist

Run before every release.

**Why this file exists.** The user journeys are described as
prose elsewhere, and prose cannot be run identically twice: two people reading "paste a magnet link"
test two different things, and the same person tests something different next month. Every item
here therefore has a **precondition**, a **fixed input**, and a **falsifiable assertion**.

**This document is deliberately incomplete.** Three items depend on artefacts that do not exist
yet; they are scheduled at the bottom rather than written as placeholders.

---

## 1. Telemetry first-run disclosure

The one item where getting it wrong is a reputational event rather than a bug
([`ADR-0004`](../decisions/ADR-0004-telemetry.md), [`ADR-0063`](../decisions/ADR-0063-telemetry-v2.md)).

**Precondition.** A packaged build (a development build never runs telemetry), a clean profile
and no stored telemetry choice. Delete both directories:

```bash
rm -rf ~/.config/orivon ~/.config/orivon-telemetry   # Linux; app.getPath('userData') and appData elsewhere
```

Have a way to observe outbound network traffic before launching: a proxy, `tcpdump`, or the
devtools network panel. **Reading the source is not sufficient for assertions 4 and 5.**

**Input.** Launch the app for the first time; press "Enter Orivon" and choose; then open Settings, Usage
statistics.

**Assertions.** All five must hold:

1. "Enter Orivon" opens the popup **Support us for free through telemetry**, with two buttons of
   the same size and style, "Accept" and "Deny", and the welcome cannot be left without one.
2. **Neither is preselected**, and no keyboard default activates one: Enter alone does nothing.
3. Settings, Usage statistics, shows the **literal JSON** of every report that would be sent,
   not a description of it, and the notice field table matches it.
4. **Nothing has been transmitted** before the choice, and nothing ever after "Deny". Verified from the traffic observation, not from the code.
5. After "Accept", the only telemetry destination is
   `telemetry.orivonstack.com`, and what is sent matches the Settings preview.

**Fails if:** a choice is preselected or reachable by a keyboard default, the JSON is
summarised, or a single telemetry request leaves the machine without "Accept".

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

**The supported path most likely to break silently.** Both systems are supported this way as well as by package
([`packaging.md`](packaging.md)), and those users count toward the success metric.
[`cross-os.yml`](../../.github/workflows/cross-os.yml) runs it every night on hosted Windows and macOS runners: the
Rule 8 guard over each system's own dependency tree, then `smoke`, which covers assertions 2 and 3 below. Read its
last run before a release (`node scripts/ci/cross-os.mjs --run latest`). What a runner cannot show is still checked
here: an install on a machine with no toolchain at all, the first-run screen, and where storage lands.

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

## 5. The macOS one-line install

**Precondition.** A published release with both dmgs attached, and an Apple silicon Mac that has
never opened Orivon (or has quit it).

**Input.** The command in the README section Download, pasted into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-macos.sh | bash
```

**Assertions.** The script prints the release's tag and "Checked the SHA-256", Orivon opens with
no Gatekeeper dialog, and **About** shows the release's version.

**Fails if:** a Gatekeeper dialog appears, the digest check is skipped, or the script installs a
different release than the newest one with a dmg attached.

---

## 6. The Linux one-line install

**Precondition.** A published release with its AppImage attached, and a Linux x86_64 computer with a desktop that has
never had Orivon installed by this script (or run `rm -rf ~/.local/lib/orivon ~/.local/share/applications/orivon.desktop`).

**Input.** The command in the README section Download, pasted into a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-linux.sh | bash
```

**Assertions.** The script prints the release's tag and "Checked the SHA-256", Orivon starts, **About** shows the
release's version, Orivon Browser is in the application menu with its icon and is listed among the desktop's browsers
(Settings > Default applications), and running the command again leaves one entry and one install.

**Fails if:** the script asks for a password, the digest check is skipped, it installs a release that is not the
newest one with an AppImage attached, or a computer without `libfuse2` gets an Orivon that does not start.

## 7. A tagged package

**Precondition.** A published release, and a Windows machine or a Linux machine that has never run Orivon.

**Input.** Download `Orivon-Setup-<version>-x64.freetube.exe` (or the AppImage tagged `freetube`) and run it on a machine with no Orivon profile.

**Assertions.** After the welcome screen, a tab opens on FreeTube's address and asks what it may do; nothing is granted by itself.
FreeTube is first in Orivon Featured. On Windows, `installer-name.txt` beside the program holds the installer's file name, and
uninstalling removes it. A second download named `... .freetube (1).exe` behaves the same. On a Mac, `curl ... | bash -s freetube` (section 5's command) does the same on the first launch it starts. Running the plain installer, or the tagged one on a
profile that has run before, opens the plain first run.

**Fails if:** the app opens without its question, the tag changes a profile that has history, or the file's name is not what
`installer-name.txt` holds.

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
- [ ] **The `.eth` light client's checkpoint is under 7 days old.** The scheduled workflow
      `refresh-eth-checkpoint.yml` opens a pull request with a fresh one every Monday and Thursday;
      merge it, or run `node scripts/refresh-eth-checkpoint.mjs --write` and commit the result. The
      Release workflow refuses a checkpoint over 7 days old, because the app refuses one over 14;
      an install of a release past that fetches a fresh one from two beacon servers when they are
      reachable and agree, and verifies no `.eth` name when they are not.
- [ ] `npm run typecheck && npm test && npm run check:natives && npm run check:contracts` green.
- [ ] CI green on `main`.
- [ ] After publishing: the Release workflow is green and the release carries the deb, the
      AppImage, the Windows installer, both dmgs and `ipfs.json` ([`packaging.md`](packaging.md)
      section Releases); its description lists the version's changes, the "Which file is mine?" table and the
      IPFS section; within about 15 minutes `ipfs://<cid>` from its notes opens in Orivon.
- [ ] **The Microsoft Store package submitted** ([`packaging.md`](packaging.md) section The Microsoft Store package):
      after the release's workflow run is green, open the `store` job's page. Its summary says it submitted the package
      and shows the submission's status; Partner Center certifies it from there. A warning instead names what is
      missing, and then the package is uploaded by hand:
      download the run's `store-msix` artifact (kept 30 days) and submit it in Partner Center under **Packages**.
      One-time setup, by the owner, in this order:
      1. The first publication is made by hand, because `msstore` only updates a product that has been published once.
         The product is an **MSIX or PWA app** (an "EXE or MSI app" product asks for installer switches and a
         certificate-signed installer instead). Its **Product identity** values match the `appx` block of
         `electron-builder.yml` (identityName, publisher, publisherDisplayName); the Store refuses a package whose
         identity differs.
      2. Upload the package in the submission's **Packages** step.
      3. **Privacy policy URL:** the GitHub address of [`docs/privacy/notice.md`](../privacy/notice.md).
      4. **Restricted capability `runFullTrust`:** a Win32 app needs it, and Electron cannot run without it. Say so:
         Orivon is an Electron application, a full desktop program that cannot run in the Store's sandbox.
      5. **Description:** it must say that Orivon runs third-party applications, and what it asks of the person
         before one does.
      6. **Age rating:** answer the questionnaire for a web browser (it reaches the open web and shows
         user-generated content from it).
      7. Once that submission is live, add the four repository secrets `MS_STORE_TENANT_ID`, `MS_STORE_SELLER_ID`,
         `MS_STORE_CLIENT_ID` and `MS_STORE_CLIENT_SECRET` from a Microsoft Entra application with the Manager role in
         Partner Center (the click path is in packaging.md), and set `store` to `true` in
         `packaging/release-routes.json`. Every release after it is a new submission made by the job; the Store checks
         that the browser stays within two major versions of the current Chromium, so an Electron update is due at
         least that often. A release published before the secrets existed is submitted by Actions > Release > Run
         workflow with its tag.
- [ ] **The winget package** ([`packaging.md`](packaging.md) section winget). One-time setup, by the owner:
      1. Create a **classic** personal access token (fine-grained tokens cannot open the pull request) with the
         `public_repo` scope, in the account the pull requests should come from, and store it as the repository
         secret `WINGET_TOKEN`. Until then the `winget` job of every release writes a warning and submits nothing.
      2. Submit the first version of each identifier by hand, since the job only adds versions to a package that
         exists: `Orivon.Browser.Preview` with the first pre-release, `Orivon.Browser` with the first full release.
         Generate the manifests with `komac new` (the same Komac version as `release.yml`) and submit them (`komac new --submit`,
         or `komac submit <folder>` for manifests already written), and on that
         first pull request accept Microsoft's contributor agreement with one comment when its bot asks.
      3. Once a pull request is merged, `winget install Orivon.Browser.Preview` (or `Orivon.Browser`) installs
         without SmartScreen; set `winget` to `true` in `packaging/release-routes.json`. Every release after it is
         submitted by the job, and a release published before the token existed by Actions > Release > Run workflow
         with its tag.
      After a release: the `winget` job's page shows either the pull request it opened or the warning naming what is missing.
- [ ] **The Arch package** ([`packaging.md`](packaging.md) section The Arch User Repository). One-time setup, by the
      owner: create an AUR account with an SSH key, store the private key as the repository secret
      `AUR_SSH_PRIVATE_KEY`, and set `aur` to `true` in `packaging/release-routes.json` once `orivon-bin` is listed.
      After a release: the `aur` job's page says it pushed `orivon-bin`, or names what is missing.
- [ ] **AppImageHub** ([`packaging.md`](packaging.md) section AppImageHub). Once, by the owner: a pull request to
      `AppImage/appimage.github.io` adding `data/Orivon_Browser`, the file in `packaging/appimagehub/`. The Hub reads
      each later release itself.
- [ ] [`CHANGELOG.md`](../../CHANGELOG.md) updated, with the `[Unreleased]` entries moved under a heading `## [x.y.z]`
      for the version being tagged: the release's description is written from that section, and a release whose
      version has none gets a warning and a description without its changes.
- [ ] Known limitations stated **in-product**, not only in the README: peers see the user's IP;
      no automatic port forwarding behind NAT; address-bar search text goes to DuckDuckGo.
- [ ] **Telemetry pre-announced.** Launch-blocking ([`readiness.md`](../planning/readiness.md)
      risk 5): telemetry discovered rather than announced is cheap to avoid and expensive to
      mishandle.
