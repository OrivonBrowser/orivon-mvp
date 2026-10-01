# `src/main/permissions/`: the grant list, and the per-site popover

**What lives here.** Two surfaces, each behind its own controller.

- **All sites**, off the toolbar's tune icon: `permissions.ts` (`PermissionsController`) lists
  grants and revokes them, recording each revoke as a declined capability (`d-0087`), and lists
  each site's remembered notification answer for reset. Revoke only: forgetting an app entirely
  is `GrantLedger.forgetOrigin`. `permissions-panel.ts` is its popup.
- **One site**, off the address pill's shield and key (`d-0037`): `site-info.ts` (pure, one row
  per declared capability), `site-switches.ts` (turn one capability off or on, re-validated
  against the manifest), `site-info-controller.ts` (the surface's one door to the broker and
  loader), `site-data-runner.ts` (Cookies and site data I/O) and `site-info-panel.ts`.

Both popups share their `WebContentsView` lifecycle through `popover-view.ts`. Rows take an
optional displayed Website level; at Level 4 their warnings are gone
([`ADR-0037`](../../../docs/decisions/ADR-0037-a-level-4-site-s-grants-are-shown-without-warnings.md)).

**Tied to Electron.** The two `-panel` files and `popover-view.ts` import `electron` values;
`site-info.ts` and `site-switches.ts` are pure. The loader's `electron/serve.ts` functions are
injected by `../shell/window.ts`, never imported here.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/),
[`../../broker/`](../../broker/) (`broker-contracts.ts`, `policy/`, `grants/ledger-storage.ts`
types), [`../../loader/`](../../loader/) (`index.ts`, `manifest/manifest.ts`),
[`../../trust/`](../../trust/) (types), [`../consent/`](../consent/) (`grant-*`,
`request-grant.ts`), [`../browsing/site-trust.ts`](../browsing/site-trust.ts),
[`../verifier/`](../verifier/) (`name-evidence.ts`, `verifier-subsystem.ts`),
[`../extensions/site-reach-runner.ts`](../extensions/site-reach-runner.ts)'s
`extensionNamesForOrigin` (`site-info-controller.ts` only -- the extensions disclosure,
`docs/planning/extensions-exploration.md`),
[`../sessions/notification-decisions.ts`](../sessions/notification-decisions.ts),
`../shell/renderer-entry.ts`, `../shell/lock-navigation.ts`, `../shell/shell-session.ts`,
`../shell/theme-colors.ts`, `../shell/view-background-test-hook.ts`,
`../ipc/permissions-ipc.ts`, `../ipc/site-info-ipc.ts`, the top-level
`channels.ts`/`registry.ts`, `node:fs/promises`, `node:path`.

**What it must never import.** Nothing bypasses either controller. Every renderer surface that
shows grants or switches reaches the broker only through `permissions.ts` or
`site-info-controller.ts`.

**Owner stream.** `shell`. Maintenance only.

## Design notes

**[`site-info-controller.ts`](site-info-controller.ts)'s `extensionsOnSite` (the extensions disclosure,
`docs/planning/extensions-exploration.md`) is computed once, ahead of the registered/
unregistered branch in `siteInfoFor`.** Which extensions can act on a site does not depend on
whether that site is also a registered app with its own capabilities -- the popup shows it on an
ordinary website too, which is the case the exploration says still matters most (no enforcement
exists there at all). Computing it once, before the branch, keeps both arms of `siteInfoFor`
(registered, unregistered, and the manifest-read failure path) from having to remember it
separately.

**The site-info popup's "Manage" link opens `orivon://extensions` through `../shell/tabs.ts`'s
`openInternal`, the same mechanism `../pages/pages-domain.ts` uses for one internal page to open
another.** `openSiteSettings` (the "Site settings" row) has the same shape (close the popup, then
act); both are wired in at `../shell/window-panels.ts`.

**The popup's Permissions section is the one place a person changes what the site in front of them
may do.** `../site-settings/site-permissions-view.ts` builds it for the popup's fixed origin, from
`../site-settings/site-settings-controller.ts`, and the popup's `sitePermissions` and
`setSitePermission` commands carry no origin of their own. The toolbar key shows on every `http(s)`
page for that reason (`siteSummaryFor`'s `asked`); an app origin gets no Permissions section, its
capability rows being the whole of what it may do.
