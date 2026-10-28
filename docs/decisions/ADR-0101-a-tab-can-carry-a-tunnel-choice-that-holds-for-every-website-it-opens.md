# ADR-0101: A tab can carry a tunnel choice that holds for every website it opens

- **Status:** accepted. Extends [`ADR-0084`](ADR-0084-the-tunnel-can-carry-the-whole-browser-and-a-website-with-an-entry-lives-in-one-of-two-shared-profiles.md) (a website lives in a shared profile when it has an entry) and [`ADR-0089`](ADR-0089-each-website-and-app-picks-its-own-tunnel-and-an-installed-apps-tunnel-is-set-as-a-websites-is.md) (an entry is `off`, Nym or the proxy, and an origin's session follows it) with a second source for the profile: the tab the website is opened in. Both stand for every website opened in a tab with no choice.
- **Date:** 2026-10-28
- **Type:** architecture / security
- **Decided by:** owner (a tunnel can be chosen for a tab before its first address is typed, and the choice lasts the whole tab); AI recommendation accepted by default for the precedence, the shared profile and the absence of a mark in the tab strip

## Decision

**A tab can carry a choice: Nym, the proxy, or direct.** It is set on a tab (a new tab included) before that tab navigates, and it holds for every website the tab shows, and for every tab opened from it, until the tab closes. It is a fact about the tab, not about a website: it is never written as an origin's entry in `routes.json`, so the choice is gone when the tab closes and no website gains or loses a tunnel of its own because a tab visited it. What a visit leaves in a profile is stated below.

**What a tab opens inherits it.** A link, a modified click, a script's `window.open` (sized, featureless or a blob), a redirect, a page opened from the context menu (in a new tab, in front, in a window, in a split), an address opened from the blocked pop-ups bubble, a link opened from Reader view, an address the site-info panel opens (a website's home, a report of a problem), an address the address bar opens in a new tab (Alt+Enter, a middle click on a suggestion), the source of an address typed there (`view-source:`) and a duplicated tab carry the choice of the tab they come from. "Open link in private window" from a tab set to Nym opens a private window held to Nym; from a tab set to the proxy it is not offered, since a private window cannot be held to the proxy; from a tab set to direct it is the ordinary private window. A blank tab opened beside a tab does not: it starts with no choice. A tab that is asleep keeps the choice it has, or takes one given while it sleeps, and wakes into the session the choice calls for; a tab already showing a website in a tunnel's profile does not sleep, as no tab in a session other than the shared one does. A tab that is saved with the session and restored comes back with its choice, and a choice read from a file that is not one of the three is dropped.

**Precedence is fail-safe: a tab is never less tunnelled than a promise made for a website.** For the website at an origin, in a tab with a choice:

| The tab | The website's own entry | The website runs in |
|---|---|---|
| no choice | any | what the entry says, as before |
| Nym | none, `off`, the proxy or Nym | Nym's profile |
| the proxy | none, `off`, Nym or the proxy | the proxy's profile |
| direct | none or `off` | the direct profile |
| direct | Nym or the proxy | that tunnel's profile |

An origin that cannot go through a tunnel (this computer, an address that is not a web origin, a page of the shell) is in no profile whatever the tab's choice. The main-frame guard on every session reads the choice of the tab that loads and judges the load against it, so a load the shell failed to move still leaves by the tunnel the tab calls for, or is cancelled.

**The websites share the tunnel's profile.** A website a tab's choice puts in a tunnel lives in that tunnel's shared profile (ADR-0089), the one a website with that entry lives in, so sign-ins and storage are those of the profile and not of the tab. A website that may not be written to disk (a plain `http` origin) is in the profile's memory twin and is recorded nowhere. The visit to any other origin is recorded in the routes as storage kept apart (the `apart`, `apartProxy` and `apartDirect` lists of `routes.json`, one for each profile), without an entry for the website, so Settings lists the storage and Clear browsing data reaches the profile. This lists the origin of every website a tab visited through a tunnel in `routes.json` until the person removes its storage; a record that cannot be saved is logged, without the address, and never undoes the navigation.

**Orivon's own requests follow the tab.** While a tab with a tunnel choice shows, or is loading, a page at an origin, the lookups made about that origin (its icon, its Web3 Score, its app manifest) are made in that tunnel's profile session, ahead of the website's own entry: the page leaves by that tunnel, and so does everything asked about it. An installed app is not a website of the tab: lookups about it are made through its own route. The address bar's suggestions for a tab with a tunnel choice are asked in the tunnel's profile session, and when that session cannot be had they are not asked at all; they are never asked directly. A direct choice, or none, asks as before.

**Failing closed.** Choosing a tunnel makes its profile ready at once, so the tunnel starts coming up while the person types. A tab that already shows a website is moved to the session its choice calls for. A move that cannot be made at all gives the choice back, so the tab never claims a tunnel its page is not using; one that stopped half-way leaves the page in the session the choice calls for and closes the view it left, so no script of the page runs on in the session it was in. A request held while the tunnel is not yet up waits; it is never sent direct.

**A private window held to Nym takes no other choice.** Nothing in such a window leaves by another route, and the route store refuses any entry but Nym there; a tab's choice is held to the same rule. A request to give a tab `direct` or the proxy is refused and the tab keeps what it had; taking a choice away, or choosing Nym, is allowed. A tab opened with another choice carries none, and the session of a website and the guard on every session judge a tab as if it carried none, so a choice that reached a tab by some other way still sends nothing out of Nym.

**The report states counts.** A bug report says how many tabs carry each choice and which tunnel the browser is set to, never an address. The log lines about a tab's choice say the tunnel and the tab's number, never a URL.

## Context

The owner's words: the tunnels button should be visible in the new tab too, so that a person can set a tunnel for that tab's navigation before the navigation begins. Until now a tunnel was chosen for a website that was already open, on its own entry (ADR-0089), so the first request of a visit always went out in the session the website's entry named, or in the shared session when it had none, which is direct unless the whole browser is on a tunnel. A person who wants a first visit to go through Nym had no way to ask for it. This change builds the tab's side in the main process; the button is a later change, so nothing in this change shows.

## Alternatives considered

- **Write the choice as an entry for each website the tab visits.** Rejected by the owner: the choice is about the tab, and an entry outlives it, so one private look at a site through Nym would send that site through Nym for good.
- **A session for each tab.** Rejected: a profile has one front and one set of tunnel credentials (ADR-0089), so a session per tab would start a front per tab, and a person would sign in again in every tab. The tunnel's shared profile is the session a website with that entry already uses.
- **Choose the tunnel for each request, inside one session.** Rejected for the reason ADR-0089 gives: Chromium sets a proxy per session.
- **A direct tab that overrides every entry.** Rejected: a promise made for a website (it is to go through Nym) would be broken by opening it in a tab set to direct, and the person who made the promise would not be told. A tab is never less tunnelled than a promise made for a website.
- **Ask the person, in a tunnel tab, to leave an installed app's own route.** Not built; see the provisional notes.

## Reasoning

The shared profile is the one place a tunnel's front, credentials, storage and the person's extension copies already live, and the guard that holds a load to its session already exists; the choice only adds a second input to the question both answer ("which profile does this origin run in?"). Putting the answer in one function of the routes (`profileForTab`) and the tab's choice in the tab means the typed address, the new-tab page, a link, a redirect, a pop-up, a wake and a restore all ask the same thing and cannot disagree. Making the order strict, tunnel over `off` and direct only over no tunnel, keeps the one property the person can rely on: a tab set to a tunnel sends everything through it, and a tab set to direct never loosens a promise made elsewhere.

## Consequences

- Every place that decides a tab's session reads the tab's choice: the typed address and the new-tab page, the checks before a navigation commits, the catch-up swap after one, the wake of a sleeping tab, a website's entry changing while a tab shows it, a pop-up, a blob tab, a restored tab, and the main-frame guard (which keys on the web contents that loads). A new way of opening a tab must pass the choice on, or it opens with none.
- Two tabs with different choices can show the same origin at once; they run in two profiles and share no sign-in. A lookup about that origin is made through the first tab with a tunnel choice that shows it. This is provisional: what would settle it is a person reporting a lookup (an icon, a score) that left by the other tab's tunnel, and the answer is then a lookup per tab, at the cost of a source that knows the page asking.
- A website that a tab put in a profile has storage there until the person removes it, like any other website with storage in a profile. Closing the tab does not remove it, and the origin stays listed as storage kept apart until it is.
- **Provisional: a visit is listed by origin.** What would settle it is a person who browses through a tunnel tab and finds `routes.json` naming the sites they visited. The answer is then a flag per profile that says it holds storage, in place of the list, at the cost of Settings no longer naming each website whose storage can be removed.
- Threat T84 (an app's route) now also reads per tab; `docs/architecture/egress.md` says where a tab's choice changes a row.
- **Provisional: an installed app in a tab with a choice keeps its own route.** An installed app has its own session and its own tunnel identity (ADR-0089), and is not moved into a profile by a tab. Whether a tab set to Nym should ask before opening an app whose route is another, or send the app through Nym, is the owner's call; what would settle it is the first person who opens an app from a tunnel tab and reports that it did not go through the tunnel they chose.
- **Provisional: no mark in the tab strip.** Nothing in the strip says a tab carries a choice. What would settle it is the button that sets the choice: its state is the mark, and the tab strip gets one only if a person cannot tell which of their tabs are tunnelled.

## Reversibility

- **Cost to reverse:** moderate. The tab's choice is a field of the tab, a function of the routes and a check in the guard; none of it is written to the person's profile except in a saved session (the choice beside the tab's address), which a build that does not know it ignores.
- **What would make us revisit:** a person who wants a choice to outlast the tab (a tunnel for a site for good is an entry, ADR-0089), or the provisional notes above settling the other way.
