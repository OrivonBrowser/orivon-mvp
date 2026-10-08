# Realignment follow-ups

Code changes the owner decided and nobody has built. One brief each: goal, likely files, test, and the
decision it implements. The decisions are in [`../decisions/decision-log.md`](../decisions/decision-log.md)
and the closed questions in [`../decisions/resolved-questions.md`](../decisions/resolved-questions.md).
An item leaves this page when it lands. Files named are the likely ones, found by search and not read
in depth: confirm before editing.

How to take one: a change to `src/contracts/` or `src/shared/` goes alone as its own PR and merges first
(F4 is one). Everything else follows the fast lane or a plan, as the size says. The orivon-qa skill
says which QA follows a UI, flow or boundary change.

## F1: Consent dialog asks on every visit (A139)

- **Goal:** the capability consent dialog appears on every visit to an origin whose permissions are not
  all decided. It carries a "Do not ask anymore" button; pressing it silences the dialog for that origin
  until the site's manifest adds a permission, after which the dialog asks again.
- **Likely files:** `src/main/consent/` (`request-grant-prompt.ts`, `install-consent-prompt.ts`,
  `grant-prompt-render.ts`), the declined-consent record in `src/broker/grants/declined-consent.ts`, and
  a new per-origin "silenced at manifest version" record beside the grant ledger.
- **Test:** unit for the record (silenced, then a manifest with one more permission asks again); an e2e
  spec in the consent area that visits twice and presses the button.
- **Decision:** `d-0582`.

## F2: Download safe list (A322)

- **Goal:** a click on a finished download opens it with the system's default program only for images,
  text, PDF, audio, video and archives. Every other type is shown in the file manager.
- **Likely files:** `src/main/downloads/dangerous-file.ts` (the block list becomes an allowlist),
  `src/main/downloads/auto-open.ts`, `src/main/downloads/README.md`.
- **Test:** unit table of extensions and media types, including an unknown type and a double extension;
  the downloads e2e spec for the click.
- **Decision:** `d-0584`.

## F3: Logo a little right of the prism (A309)

- **Goal:** on the welcome screen the brand logo is visible, placed a little to the right of the corner
  prism, so neither covers the other.
- **Likely files:** `src/renderer/intro/style.css` (`.brand-logo`, `.prism`).
- **Test:** the welcome-screen visual baseline (`npm run qa:visual`); re-record it from a build of main.
- **Decision:** `d-0585`.

## F4: Node-exact `writeFile` (A217), contracts PR first

- **Goal:** `orivon.fs.writeFile` fails with `ENOENT` when the parent directory is missing, as Node does,
  instead of creating it. Check the other `fs` calls the same way: where Node fails, the capability fails
  with the same code.
- **Likely files:** `src/broker/adapters/node-fs-adapter.ts` (the mkdir before the write), the wording
  in `src/contracts/capability-api.ts` and `docs/architecture/capability-api.md`, the shim's `fs` in
  `src/shim/`. The contract text goes in its own PR first; the broker change follows.
- **Test:** an adapter unit test for the missing parent; the app-behaviours catalogue row and e2e spec
  for `fs` (see `test/app-behaviours/README.md`); tests that pin the old behaviour are rewritten.
- **Decision:** `d-0576`.

## F5: Remove the reading-list view (A339)

- **Goal:** the side panel no longer offers an always-empty Reading list view.
- **Likely files:** `src/main/side-panel/views/reading.ts` and its registration in
  `src/main/side-panel/panel-views.ts`, the picker row, and any doc line that names it.
- **Test:** the side-panel unit tests and e2e spec lose the view and still pass.
- **Decision:** `d-0585`.

## F6: A layer guard (A85)

- **Goal:** `npm run check:layers` fails when a directory imports what its README forbids: `policy/` does
  no I/O, `handles/` imports no `node:*`, `adapters/` no `electron`, `src/broker/` none of the shim,
  loader, preload or renderer. A named exemption covers `grants/node-ledger-storage.ts`.
- **Likely files:** a new `scripts/check-layers.mjs` generalising `scripts/check-contracts-pure.mjs`,
  `package.json`, `.github/workflows/ci.yml`, `docs/development/testing.md` (the guard list), and
  `src/broker/transport/ipc.ts`, which imports `src/main` today (A203) and needs its own exemption or a
  fix.
- **Test:** a unit test with a violating and a clean fixture tree; the guard passes on main.
- **Decision:** `d-0585`.

## F7: Generic test app name (A201)

- **Goal:** the test app in `test/apps/freetube/` and the specs that drive it get a generic name after the
  behaviour they test. The app that inspired a test is named in a code comment only. The same applies to
  any other test named after a ported app.
- **Likely files:** `test/apps/freetube/`, `test/support/freetube-fixture.ts`,
  `test/ported-apps/e2e-freetube-app.test.ts`, `test/capabilities/fixture-as-page.ts`,
  `test/impact-map.json`, `test/spec-weights.json`, `test/README.md`. Run `npm run check:test-paths`.
- **Test:** the renamed specs pass; `select-e2e` still names them.
- **Decision:** `d-0577`.

## F8: Update check on by default, install on "Yes, install" (A275)

- **Goal:** the update check runs by default. Installing a signed update always waits for the person's
  "Yes, install". The release page or `download.orivonstack.eth` is always offered as a manual path.
- **Likely files:** `src/main/settings/schema.ts` (`updates.check` default), `src/main/self-update/`
  (the check and its README), the signed-install work in the self-update branch, the Settings update
  card (`src/renderer/site-info/update-card.ts` is the site card; the Settings row is in the
  Settings page under `src/renderer/pages/`), `docs/privacy/outbound-requests.md` (the check becomes a default request).
- **Test:** unit for the default and the schema migration; e2e that a pending update asks and does not
  install without the click.
- **Decision:** `d-0579`.

## F9: Direct gateway route line and switch (A264)

- **Goal:** Settings' verifier section says when Orivon went around the resolver to reach a gateway, and
  has a switch that turns the direct route off.
- **Likely files:** `src/main/verifier/` (where the route is chosen and logged), `src/main/settings/schema.ts`,
  the Settings page, `docs/architecture/security-model.md` (T40).
- **Test:** unit for the switch off (the route is refused); a Settings e2e for the line.
- **Decision:** `d-0585`.

## F10: Developer mode from Settings (A299)

- **Goal:** developer mode is a Settings switch read at launch. `ORIVON_DEV_ORIGINS` is honoured only in
  an unpackaged build.
- **Likely files:** `src/main/dev/dev-mode.ts`, `src/main/dev/README.md`, `src/main/settings/schema.ts`,
  `src/main/shell/tests/dev-switches.test.ts`, `docs/architecture/security-model.md` (T13c).
- **Test:** unit for packaged and unpackaged with the variable set; the dev e2e specs still start in dev
  mode through the variable.
- **Decision:** `d-0585`.

## F11: Separate provider key (A391), owner action

- **Goal:** the official Web3 Score provider's key is held apart from the key that publishes Explore's
  name, so one compromise cannot pass an app's update as verified under its own name.
- **Likely files:** none in this repository first: the provider lives in web3-score-manager and the
  names in the owner's ENS account. Afterwards `docs/architecture/security-model.md` (T81) and the
  default provider address in `src/main/settings/schema.ts` if it changes.
- **Test:** a verified-update e2e against the new provider address.
- **Decision:** `d-0585`.

## F12: Identity connects automatically on a Level 4 site

- **Goal:** when the wallet and the named-identity path land, a wallet account, a Nostr identity or an
  orivon.id identity connects to a Level 4 site without a prompt; any other site asks; an action that
  moves value always prompts.
- **Likely files:** `src/contracts/` (`orivon.id.requestIdentity`, a contracts PR first),
  `src/nostr/nip07.ts`, `src/main/consent/`, `docs/architecture/capability-api.md`.
- **Test:** a connect e2e on a Level 4 fixture (the developer score override) and on a lower one; a value
  action that prompts on both.
- **Decision:** `d-0570`, [ADR-0067](../decisions/ADR-0067-wallet-accounts-and-named-identities-connect-automatically-only-on-a-level-4-site.md).

## F13: Ports onto the Node shim when touched (A313)

- **Goal:** each port bundles against the Node shim instead of its own polyfills and empty stubs, moved
  over when the port is next touched.
- **Likely files:** `src/shim/bundler/esbuild-plugin.ts` and a webpack preset of the same alias table and
  page globals for the ports built with webpack; the ports themselves live in the ports repository.
- **Test:** the port's own e2e spec in `test/ported-apps/` or the ports checks; the shim conformance
  tests for the preset.
- **Decision:** `d-0585`.

## F15: Port specs named after the behaviour they prove

- **Goal:** the specs in `test/ported-apps/` (`e2e-freetube-*.test.ts`, `e2e-the-lounge-real.test.ts` and
  their helpers) take names that say what they prove, such as a Node server in a tab or real TCP to an
  IRC server; the app each one runs is named in a code comment.
- **Likely files:** `test/ported-apps/`, `test/impact-map.json`, `scripts/ci/select-e2e.mjs` if it names
  them, `test/app-behaviours/catalogue.md` rows that cite them.
- **Test:** `npm run check:test-paths`, `check:impact-map` and `check:app-behaviours` pass; CI selects the
  renamed specs for a change in their area.
- **Decision:** `d-0577`, CLAUDE.md Rule 20.

## F16: The levels link in the site-info popover

- **Goal:** the site-info text that explains the Web3 Score levels stops pointing at the outdated docs
  site and points at a page that says how the levels work now.
- **Likely files:** `src/renderer/site-info/web3-view.ts` (`SCORES_PAGE`), the page it should name.
- **Test:** the site-info unit test that renders the "no provider" text.
- **Decision:** `d-0573`.

## F14: Smaller accepted items

These are decided and small enough to ride along with other work in the same area.

- **A161:** `src/main/consent/grant-prompt-origin.ts` uses `tldts` (already used in
  `src/main/privacy/site-of.ts`) to keep the tenant label. Test: a table of hosts such as
  `bucket.s3.us-east-1.amazonaws.com`. Decision `d-0585`.
- **A189:** call `HandleTable.dropOrigin` (`src/broker/handles/handles.ts`) on navigation and session
  teardown so an abandoned `fs.open` handle gives back its fd. Test: open, navigate away, assert the fd
  closes. Decision `d-0585`.
- **A206:** the site-data page deletes an app's private files through a broker method that revokes the
  handles, deletes the directory and resets the byte counter; a delete Windows blocks reads "In use:
  close the app and retry" (`src/renderer/site-info/data-view.ts`). Decision `d-0585`.
- **A236:** the publisher documentation states that `version` is bumped every release for the update
  check at a plain host to see it (`docs/architecture/app-compatibility.md`). Decision `d-0585`.
- **A371:** the password export leaves the password cell raw and its confirmation says so
  (`src/main/passwords/passwords-transfer.ts`); the formula-guard for other cells stays. Test:
  `src/main/passwords/tests/passwords-csv.test.ts`. Decision `d-0585`.
- **A66, A245, A252:** the threat-model text for the accepted residuals (rebind window, public name to the
  LAN under `*:443`, loopback fetch) goes into `docs/architecture/security-model.md`. Decision `d-0583`.
- **A320:** Settings and the privacy pages disclose the spell-check dictionary download
  (`docs/privacy/outbound-requests.md`, `docs/known-limitations.md`). Decision `d-0580`.
