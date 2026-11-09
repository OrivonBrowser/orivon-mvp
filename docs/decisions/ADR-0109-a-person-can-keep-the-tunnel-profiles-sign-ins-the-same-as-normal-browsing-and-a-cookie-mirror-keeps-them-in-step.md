# ADR-0109: A person can keep the tunnel profiles' sign-ins the same as normal browsing, and a cookie mirror keeps them in step

- **Status:** accepted. Amends [`ADR-0084`](ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md) (where a website's sign-ins live while the new setting is off) and carries out `d-0779`.
- **Date:** 2026-11-09
- **Type:** product / security
- **Decided by:** owner

## Decision

**A setting, on by default: "Keep tunneled sites separate"** (`network.tunnel.separateSignIns`, Settings under Tunnels). On, everything in [`ADR-0084`](ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md) stands: the profile sessions (`persist:tunnel-profile`, `persist:proxy-profile`, `persist:direct-profile`) hold cookies of their own, apart from the default session's.

**Off, the cookies of the three persistent profile sessions and of the default session are kept the same, in both directions.** A tunnelled tab keeps its route and its session exactly as before (every request still leaves by the tab's tunnel, a website's third-party requests included) and sends the cookies normal browsing holds; a sign-in made in either place is in the other. What a site keeps in page storage (localStorage, IndexedDB, caches, service workers) stays apart. The copy is `src/main/route/cookie-mirror/`:

- **Turning it off** merges the sessions once: the default session wins where both hold a cookie of the same name, domain and path; a cookie only a profile holds goes to the default session; then every cookie is written into each profile that lacks it or holds another value.
- **From then on** each session's `cookies` `changed` event is followed. A change is not copied from the event: the cookie is read again in the session it came from and in the other, and written only where they differ, so a change the mirror itself made finds both sides equal and ends there, and an event that was overtaken carries what is true now. A cookie changed again before it is carried is carried once. No memory of its own writes is kept. As a bound against a store that keeps changing what it is given, a cookie is written into one session at most 30 times in 5 seconds.
- **Which changes count.** An insert, a change of attributes, a removal by a person or a site (`explicit`), and a site's deletion by sending the cookie already expired (`expired-overwrite`, which is how a sign-out arrives). Not the removal half of an overwrite (an insert follows), not a cookie that ran out (`expired`) and not one evicted from a full store: each session lets those go by itself.
- **Attributes.** A host-only cookie is written with no domain, so it stays host-only; a domain cookie keeps its domain; `secure`, `httpOnly`, `sameSite`, path and expiry are kept, and a session cookie is written with no expiry, so it stays one. A removal by address and name takes every cookie of that name the address would send, so the other cookies of that name the source still holds are put back.
- **Partitioned cookies** cannot be told apart. Electron 44's `Cookie` and `CookiesSetDetails` carry no partition key, and `cookies.get` lists a partitioned cookie like any other (measured: one set by a page under its own site and one set by an embedded frame both come back, with no mark). A cookie is therefore carried as an ordinary one, except where a listing shows two cookies of one name, domain and path, which a cookie jar holds only for partitioned cookies: those are left alone, in both directions, and the log says so once without naming one. A lone partitioned cookie reaches the other session as an unpartitioned `SameSite=None` cookie, which that session already accepts from any embedded site; third-party cookie blocking, which works on the request, applies to it as to any.
- **Which sessions.** Only the kept (`persist:`) session of each of the three profiles and the default session. Never a private window's process (it runs no mirror), a profile kept in memory (plain-http origins), an app's session (`persist:app-*`), a temporary session or an internal one.
- **Which profile sessions.** One made after the mirror started joins as it is made, through the website-sessions seam, and its first request waits (at most 8 seconds) until it holds what the default session does. Profiles that already have data on disk are made when the mirror starts, so that a sign-in deleted in normal browsing while a profile was not loaded cannot return from the profile's stale copy.
- **Turning it back on** stops following and clears the cookies of every profile session, so the tunnelled identity is separate again; normal browsing keeps its own, and a tunnelled site asks for sign-in once. Settings says so in one line.
- **`orivon://report`** states the mirror's state, how many profile sessions it keeps in step and how many cookies it wrote, removed and failed to write (`diagnostics.browser.signIns`): counts and one word, never a cookie's name, value or site.

## Context

[`ADR-0084`](ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md) keeps a tunnelled website in a profile session of its own so that its sign-ins cannot link the tunnelled visits to the person's accounts. The owner, 2026-11-09: tunnels run on a separate session to preserve identity, "but users should be allowed to disable this behavior in settings, to keep the same accounts even while tunnels are enabled". Shown two ways, the owner chose to share sign-ins and keep each tab's own route.

## Alternatives considered

- **Route by site name in the default session** (a website that has an `on` entry stays in the default session and the session's proxy rules send its host through the tunnel). Rejected by the owner: a proxy chosen by host name in one session leaves a site's third-party requests outside the tunnel, and it cannot give one tab a tunnel its neighbour lacks.
- **Add the default session's cookies to each profile request in `webRequest`.** Rejected: `Set-Cookie` and `document.cookie` writes of the tunnelled page would still need carrying back, httpOnly cookies and every redirect would have to be handled by hand, and it is work on every request instead of on every change.
- **Remember what the mirror wrote and ignore the matching events.** Rejected: a write that changes nothing may raise no event (or a different one), and a remembered expectation that is never met swallows a real change later. Reading both sessions' current state needs no memory and ends when they agree.
- **Follow `expired` and `evicted` removals too.** Rejected: a cookie that ran out is gone from every session at its expiry, and one evicted because a single store was full would sign a site out of the others.
- **Leave the profiles' cookies where they are when the setting is turned back on.** Rejected by the owner's wording ("so the tunneled identity is separate again"): the copied sign-ins would stay linked to normal browsing.
- **Let a late profile join without waiting.** Rejected: the first page of a profile made while the setting is off would load signed out and sign in on a reload.

## Reasoning

A copy driven by the session's own change events is the smallest thing that keeps the tunnel's route and storage as they are and still shares the one thing the owner named, sign-ins. Reading the current state rather than trusting an event keeps it from looping and from carrying a stale value. Bringing profiles that exist on disk in at start is what makes a sign-out in normal browsing reach a profile that was not loaded at the time.

## Consequences

- While the setting is off, a website in a tunnel profile sees the accounts of normal browsing: that link between a tunnelled visit and the person's accounts is what the person chose. The tunnel still hides the computer's address from the site.
- Only cookies are shared. A site that keeps its session in localStorage or IndexedDB signs in again in a tunnel profile.
- A change in either place reaches the other: a person who clears cookies in normal browsing clears them in the profiles, and removing a website's storage from the tunnel list in Settings also removes its cookies from normal browsing while the setting is off.
- A partitioned cookie that is not shown twice is carried as an ordinary cookie, and the attributes Electron does not expose (priority, source scheme and port) are not carried.
- The notice before a website first moves into a profile says the person stays signed in, and that only its other storage stays apart, while the setting is off (`SiteTunnel.signInsShared`).
- Turning the setting back on deletes the profiles' cookies for good; the extensions' own storage in the profiles is not touched.
- Work: one change event per cookie change in four cookie stores and a read or two per change; a merge at start writes only what differs. The profiles with data on disk are made at start while the setting is off. A profile made while it is off waits for its cookies before its first request, up to 8 seconds.
- Two profiles that hold different values of one cookie the default session lacks, found when the setting is turned off, give the default session the value of the profile made first.

## Reversibility

- **Cost to reverse:** cheap. The mirror is additive and the setting's default is the earlier behaviour; the one thing that does not come back is a profile's cookies once the setting has cleared them.
- **What would make us revisit:** an Electron cookie API that carries the partition key (to carry partitioned cookies as they are, and to leave out every one now carried as an ordinary cookie), or a way to run a tunnelled website with its own route inside the default session without letting its third-party requests out (to replace the copy with one jar).
