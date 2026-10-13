# ADR-0082: A website's tunnel state is kept per origin, and a website whose state differs from the default has storage of its own

- **Status:** accepted; its storage decision (one session of its own per website) is superseded by [ADR-0084](ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md), which puts every website with an entry in one of two shared profiles. *Provisional* on a Web3 name: its own files are fetched by Orivon's verifier host, which the tunnel does not carry yet, so the popover says the site goes through the tunnel only in part. Settled when the verifier host takes a route per request.
- **Date:** 2026-10-13
- **Type:** architecture / security
- **Decided by:** owner (the feature: `d-0619`); AI recommendation accepted by default for the shape

## Decision

Every web origin has a tunnel state, `on` or `off`. The person sets it per origin: for an installed app on its card in Apps (as [`ADR-0080`](ADR-0080-an-installed-app-can-send-everything-through-one-proxy.md) says), for a website from the site-info popover ("Use the tunnel for this site") or from Settings. An origin with an entry of its own takes it; an origin with none follows the browser's default, which is off. The rule is `tunnelStateOf(entry, everywhere)` in `src/main/route/route-state.ts`.

A website whose state differs from the default runs in a session of its own, `persist:site-<sha256(origin)>`, kept across restarts. A session for an origin that may not be written to disk (plain http) has the same name without the prefix, so it lives in memory. The session gets what an app's routed session gets: a loopback front with tunnel credentials of its own, the bypass rules that leave only this machine out, `disable_non_proxied_udp` on every web contents, icons and Web3 Score looked up through it, and the leaving question when its page opens another site. Every other website stays in the shared session. A tab moves between the two with the cross-session move Back already uses.

Before a website first moves into storage of its own the popover says so in plain words and asks for a Confirm: *This site gets its own storage. You'll sign in to it again once, and what it stores stays apart from the rest of your browsing.* Turning the tunnel off returns the tab to the shared session; the site's own storage is kept, and Settings lists it with *Remove its separate storage*. Turning it on again asks nothing.

Every privacy control that a website's requests meet in the shared session (the header signals, third-party cookie blocking, HTTPS-only, the per-site content blocks, the sign-in identity headers, the verifier's page stamp, the first-visit hook) is installed on every session a website runs in, through one seam (`src/main/sessions/website-sessions.ts`), so a website that moves does not lose a setting.

A session is held shut until its front runs: a request made in the first moments waits, and a session that cannot be made ready refuses everything, never falling back to the system's proxy.

## Context

The owner decided that the tunnel works for every website, not only for installed apps, and that a person can later turn it on for the whole browser while leaving one site or app off. Only a session of its own can be pointed at a front without touching every other site, and a website kept in the shared session cannot be routed alone. The cost of a session of its own is that the person signs in again, which is why they are told first.

## Alternatives considered

- **Point the shared session at the tunnel when any site is on.** Rejected: it routes every site, and the person asked for a choice per site.
- **A session in memory for every tunnelled website.** Rejected: signing in again at every start makes the tunnel unusable for any site with an account.
- **Share one session among all tunnelled websites.** Rejected: one tunnel identity for them all would let Tor correlate the sites, and their cookies would sit together; the origin is the unit, as for permissions and apps.
- **Move the tab without telling the person.** Rejected: the person would be signed out of the site with no explanation.
- **Delete the site's storage when the tunnel is turned off.** Rejected: turning it on again would sign the person out a second time, and deleting what a person did not ask to delete is the worse surprise.

## Reasoning

A session is the one unit Chromium lets a proxy, a cookie jar and a cache be set for, so storage of its own is the price of a tunnel of its own. Naming it from the origin's hash gives it the same shape as an app's partition, so the existing cleanup and attribution rules read it the same way. Holding the session shut until its front runs, and installing the privacy controls through one seam, make the move safe at the first request instead of after it.

Measured on Electron 44 before building (headless): cookies in `persist:site-<hash>` survive a restart and stay apart from the shared session's.

## Consequences

- Moving a website reloads it in a new view, so what the page held in memory is lost, and a form being typed is not kept.
- A website in a session of its own is not reached by a Chrome extension: extensions load into the shared session ([`ADR-0044`](ADR-0044-a-grant-no-longer-gives-an-origin-its-own-session.md)), so an ad blocker does not run on a tunnelled website; the popover names the extensions that stop.
- A Web3 name's own files, its Helios RPC and CCIP calls are fetched by the verifier host outside the tunnel; the popover and the address bar's key say so, and the key is never shown as fully tunnelled for such a name.
- When the list of tunnel settings cannot be read, every website counts as on while a tunnel is set, each in its own session, until the person mends the file.
- `localhost`, loopback addresses and anything that is not an `http` or `https` origin cannot be switched.
- A website that is later installed as an app keeps its entry: its app partition is pointed at the same front.

## Reversibility

- **Cost to reverse:** moderate. The state rule and the store are small; the sessions of existing sites would have to be merged back into the shared one, which signs the person out of each.
- **What would make us revisit:** the verifier host taking a route per request, which ends the provisional part; a Chrome extension host that reaches more than one session; or the owner's first use showing that one switch per origin is too fine for a site spread over several subdomains.
