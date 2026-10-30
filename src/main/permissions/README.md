# `src/main/permissions/`: the grant list, and the per-site popover

**What lives here.** The grant list, the apps card in Settings and the per-site popover, each behind its own controller.

- **The grant list**: `permissions.ts` (`PermissionsController`) lists every app the broker knows with what it holds
  and the files it was given, and takes a picked path away; a revoke it makes is recorded as a declined capability
  (`d-0087`). Forgetting an app entirely is `GrantLedger.forgetOrigin`. A local file is not listed here: it is not an app a
  person installed, and the privacy page lists the recorded ones.
- **The apps card in Settings**: `apps-domain.ts` (the `apps` domain, checking every field of a request) and `app-switches.ts`
  (`AppSwitches`: one row per capability an app declares or holds, built by `app-capability-rows.ts` for an app not opened this session,
  and the switch that moves one through `site-switches.ts`, the door the key popup uses). A permission is switched, never revoked
  with a button; an app switched fully off is still listed, because its record remembers the refusal.
- **One site**, off the address pill's shield and key (`d-0037`; a local file is named by its path, shows no Web3 Score, and has Turn off and Delete data): `site-info.ts` (pure, one row
  per declared capability), `site-switches.ts` (turn one capability off or on, re-validated
  against the manifest), `site-info-controller.ts` (the surface's one door to the broker and
  loader), `site-data-runner.ts` (Cookies and site data I/O) and `site-info-panel.ts`. The controller also
reports the update a moved name offers the installed app and takes the person's choice to apply it
(`ADR-0056`). Its `siteSummaryFor` says whether the toolbar key wears a dot (`missing`: an app's declared capability is
off, or the app was never let in), and an app never let in carries `SiteInfo.notLetIn` and has `reviewPermissions`
(`ADR-0085`); what it asks of the first visit (`AppEntry`) is injected by `../shell/window-panels.ts`.

The tunnels page also opens for a tab rather than a site: `site-info-tab.ts` (pure) words the tunnel rows of "This tab" for the tab's own choice (and, while the tunnel settings cannot be read, for the one tunnel every website takes then), and the controller's
`tabInfoFor` and `setTabTunnel` read and move that choice through the tab manager (`../shell/tab-tunnel-choice.ts`). The popup opened this way is bound to the tab, not to an origin,
and answers only the tunnel commands (`../ipc/site-info-tab-ipc.ts`).

Both popups have a second panel, Browser-wide. `site-info-browser.ts` (pure) builds `SiteInfo.browserTunnel` from the settings: the tunnel the whole browser is on (none, Nym or the person's proxy), the default one, whether the IPFS and Swarm nodes follow it, why a tunnel cannot be chosen, and the tabs that keep a choice of their own. Only the popups add it (`withBrowserTunnel`), not the toolbar's per-tab read. The controller's `setBrowserTunnel` saves the tunnel before it turns the browser-wide switch on, so the route never sees the old tunnel switched on, and `setNodesTunnel` saves whether the nodes follow it; both are refused while the settings cannot be read and in a window held to Nym. The settings are reached through the `BrowserTunnels` interface that `proxy-setup.ts` implements.

The site-info popup and the Available networks popup ([`../networks/`](../networks/README.md)) share their `WebContentsView` lifecycle through `popover-view.ts`: it closes a popup on blur, on Escape
(each page asks main to close it over its own channel) and when another popup opens, hands the keyboard back to the tab in front
when the popup held it, and keys a toggle by the icon that asked, so the key and the shield swap one page for the other. A re-click on the icon that opened it is judged by the stamped press it completes (`../shell/press-stamps.ts`), so a slow click closes the popup and leaves it closed. A tunnels list opened on a tab whose first page has not committed outlives that page's arrival: the page takes the keyboard as it commits, which the popup takes back once (`popover-arrival.ts`; not when something was pressed or tapped in the page first, nor when the page took the keyboard before the popup held it), and the popup stays when the tab's address first appears if it is about that address or that tab (`closeUnlessAbout`). Rows take an
optional displayed Website level; at Level 4 their warnings are gone
([`ADR-0037`](../../../docs/decisions/ADR-0037-a-level-4-site-s-grants-are-shown-without-warnings.md)).

**Tied to Electron.** `site-info-panel.ts` and `popover-view.ts` import `electron` values;
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
`../shell/renderer-entry.ts`, `../shell/lock-navigation.ts`, `../shell/press-stamps.ts`, `../shell/shell-session.ts`,
`../shell/theme-colors.ts`, `../shell/view-background-test-hook.ts`,
`../ipc/site-info-ipc.ts`, the top-level
`channels.ts`/`registry.ts`, `node:fs/promises`, `node:path`.

**What it must never import.** Nothing bypasses either controller. Every renderer surface that
shows grants or switches reaches the broker only through `permissions.ts` or
`site-info-controller.ts`.

**Owner stream.** `shell`. Maintenance only.

## Design notes

**An app's route switch lives on its card and its state in the popover.** `apps-domain.ts` lists each app's route state and
what blocks turning it on (no proxy, or the app's files are not held here), and `setRoute` turns it on only when
nothing blocks it; the popover's `SiteInfo.route` carries the state of a routed app so it can say where the traffic goes
and when the tunnel is not answering. A website and an installed app have the same switches in the popover's tunnels page (the page the address bar's tunnel button opens): `SiteInfo.tunnel` says which tunnel it goes through (`via`: Nym, the person's own proxy, or none), whether that is the browser's default it follows, why each tunnel cannot be chosen now (no proxy address, Nym switched off, an app's files not held here), which first move into a profile needs the storage notice first (never for an app), whether it is a Swarm address, which does not open while a tunnel is on for it, and whether the page does not choose here (`fixed`: a page opened through an app's tunnel, or by an app whose session it runs in; `inSession` sets that from the tab's session); `setTunnel(origin, kind | null)` takes the choice through the route's one switch path. The person's proxy is set from the same page: `SiteInfo.tunnel.proxy` carries the saved address and how many sites and apps go through it, `setProxyAddress` checks an address as Settings does (`../settings/proxy-checks.ts`) and saves it through the settings store (`proxy-setup.ts`), and `testTunnel` is Settings' Test (`../route/route-domain.ts`'s `testTunnel`). Both are refused in a window held to Nym. The route itself is [`../route/`](../route/README.md)'s.

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
