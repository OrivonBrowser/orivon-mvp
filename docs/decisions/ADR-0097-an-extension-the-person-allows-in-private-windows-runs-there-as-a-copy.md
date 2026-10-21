# ADR-0097: An extension the person allows in private windows runs there as a copy

- **Status:** accepted; narrows [ADR-0042](ADR-0042-each-profile-and-each-private-session-is-a-process-of-its-own.md), whose private session started with no extension
- **Date:** 2026-10-21
- **Type:** security
- **Decided by:** owner

## Decision

Each installed extension has a switch, "Run in private windows", off until the person turns it on, on the extension's
details page in a normal window. When a private session's directory is made, every extension of the opening profile that is
enabled and has the switch on is copied into it: its folder, its choices (grants, site access, pin, shortcuts, page
overrides, notices seen, the switch itself; any choice added later stays out until it is named), and a copy of its own
storage. The private session loads that copy like any other registry and keeps every later change in memory, so nothing it
does there is written back to the profile, and the directory is deleted with the session.

- **Its own storage only.** The stores behind `chrome.storage` (local and sync), the extension's IndexedDB and its service
  worker cache, from the default session and from the tunnel profiles' sessions. Never a store websites share: `Local
  Storage` (which holds the extension's `localStorage` beside every site's), cookies, history, caches and service worker
  registrations. An extension's `localStorage` therefore starts empty. A `LOCK` file or a link is never copied.
- **A copy that fails never stops the window.** Each file is copied on its own (Windows may hold one open in the opening
  process); a store that cannot be copied whole is left out and the extension starts blank there; an extension whose own
  files cannot be copied is left out and logged.
- **Installs stay refused.** A private session adds, removes, turns off and allows nothing; the page and the toolbar menu
  say that is done in a normal window. Opened from a private window, the next private window copies from that window's
  directory, so the allowed set carries on.
- **Orivon cannot stop an allowed extension from recording what the person visits in a private window.** The switch says
  so beside it. That is the cost of running the extension at all, and is why the switch is off by default.

## Context

ADR-0042 gave a private session "settings and the light client's checkpoint and nothing else", and decisions
`d-0351` and `d-0359` followed from it: no extension loaded and the Extensions button hid. A password manager or a content
blocker is the reason many people open a private window with a browser at all, and without it the window is poorer
than a normal one in a way that is hard to explain. The owner chose, as Chrome's "Allow in Incognito" does, to let the
person decide per extension, and chose that the extension starts with a copy of its data so a password manager stays
signed in.

## Alternatives considered

- **Run every extension in a private window.** Rejected: an extension that is not meant to see private browsing would
  see it, with no choice made.
- **Share the profile's live extension storage with the private session.** Rejected: the private session would write into
  the profile, which ADR-0042 promises it never does.
- **Start the extension with blank data.** Rejected by the owner: a password manager would be signed out each time.
- **Copy the whole `Local Storage`, cookies or the service worker database to be safe.** Rejected: they hold what sites keep, so
  a private session would start with the person's browsing data.

## Reasoning

The person who turns the switch on has made the decision that matters (this extension may see private browsing), and the
copy gives it what it needs to be useful while the profile stays untouched. Copying only paths named for the extension's
own origin keeps the browsing data out by construction rather than by filtering.

## Consequences

- A private session's start waits for the copy of the extension data (tens of megabytes for some extensions, each file
  also scanned by an antivirus on Windows), made a few files at a time without holding the window that asked; a failure
  only costs that extension its data.
- An extension's `localStorage` and a cookie it set do not carry over.
- The profile's other sessions' data of the extension (a tunnel profile's) is copied too, so a site in a tunnel profile
  sees the same extension state.
- The copy of a store read while the profile's process writes it can be a moment behind it. That is the cost of copying a
  live database without stopping the profile.
- The security model's entry for private sessions says what is carried and what is not.

## Reversibility

- **Cost to reverse:** cheap. Drop the copy step and the switch; a private session starts with no extension again.
- **What would make us revisit:** a copied store that opens corrupt on a Chromium update, or an extension that records
  private browsing in a way the person did not expect from the line beside the switch.
