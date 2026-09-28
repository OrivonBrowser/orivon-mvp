# ADR-0041: The shell's own pages live at `orivon://` in a session only they can load

- **Status:** accepted
- **Date:** 2026-09-28
- **Type:** security
- **Decided by:** owner, for Settings and the pages after it being pages in tabs; AI recommendation,
  accepted by the owner, for the scheme, the session and the rules that keep a website out.

## Decision

The shell's own pages (Settings, History, Profiles, Private) are documents at
`orivon://<page>[/path]`, shown in ordinary tabs and reached by typing the address or from the shell.

- **One session can load them.** `orivon://` is served by `protocol.handle` on a single in-memory
  session, `orivon-internal`. The default session and every app's have no handler, so a website
  cannot navigate to, frame or `fetch` an internal page, whatever address it names. The scheme is
  registered `standard`, `secure` and `supportFetchAPI`, and nothing else: it bypasses no CSP.
- **Only the shell opens one.** `TabManager.openInternal` is called for an address the person types
  and by a command from the chrome view. A website's `window.open('orivon://…')` reaches
  `createTab`, which refuses the address like any other it cannot open. A page has one tab per window.
- **A tab on a page stays on it.** A link, a popup or a script navigation from an internal page to a
  website opens an ordinary tab in the default session, never in the internal one. The tab's view is
  closed, never parked, when it leaves the page; the person going to a website from it gets an
  ordinary tab through the usual partition swap.
- **A page's files are a fixed set.** The request path is checked before it becomes a path on disk:
  a page is one of a fixed few names, a file is a plain file under `assets/` of a listed type, and
  anything else is not found. Pages have a strict CSP (own scripts, inline styles, no network of their
  own) and the session cancels any request to another origin as a second lock.
- **Pages ask main one thing at a time.** One channel carries `{ domain, command }`. Every call must
  come from the top frame of a webContents the shell opened as that page, in the internal session,
  still at that page's own address, and must name a domain that page is allowed. A refusal is silent.
  The preload exposes the bridge only when the document's scheme and host are the page the shell named
  in an argument at construction.

## Context

Settings needs room for many sections, search and deep links, which a 380 px popover cannot give.
The popovers load `file:` pages by path, so their address is a file path, they cannot be linked, and
every `file:` page shares one origin. The reserved `orivon*` scheme prefix was already refused as an
external link, so the name was free.

## Alternatives considered

- **`file:` pages in tabs.** The address bar would show a path on disk, a page could not be linked
  to, and every internal page would share the `file:` origin.
- **A local HTTP server.** A port reachable by every process on the machine, and by a website that
  guesses it (`T12`).
- **`https://<page>.orivon`, the suffix `ADR-0038` routes to the verifier.** Served over loopback to
  the default session too, so any website could `fetch` the page's source, and the page would run in
  the same session as websites.
- **The scheme handled in every session.** A website could then load and frame an internal page. The
  preload gate would still hold, but the page's content and its structure would be readable.

## Reasoning

Confining the scheme to a session no website ever runs in makes "a website reaches an internal page"
false by construction, not by a check that must be remembered. The remaining rules cover the ways
the shell itself could hand a website in: a popup, a navigation, a parked view, a path that reaches
past the page's files. Measured on Electron 44 (`docs/planning/spike-results/shell-features.json`,
S4): a page loads and runs its own script and stylesheet with inline script blocked, and from the
default session the top-level load, an iframe and a `fetch` all fail.

## Consequences

- The shell has its first privileged scheme. `registerSchemesAsPrivileged` may be called once before
  ready, so any scheme added later joins the same call.
- Internal pages have no network: every fact on them arrives over the one channel, and the CSP says
  so. In development the dev server is reached from main, not from the session.
- Typing `orivon://settings` works; the scheme name is visible to people and to links, so renaming
  it later breaks them.
- Each page adds a domain to the channel and an entry to the build, not a channel of its own.

## Reversibility

- **Cost to reverse:** moderate. The pages are ordinary documents; the scheme name is the part that
  people and links come to depend on.
- **What would make us revisit:** an Electron release that lets a session's `protocol.handle` scheme
  be reached from another session, or a page that needs the network.
