# `src/main/privacy/`: what the browser keeps, and what it lets out

**What lives here.** Two jobs. Forgetting: `clear-data.ts` does "Clear browsing data": history back as far as
chosen, the cookies and storage of ordinary websites, the cache, the saved zoom levels, and (only when asked for
by name) the browser storage of every cache-served app that holds permissions; `privacy-domain.ts` is what the
Settings page may ask: how much is kept, and to clear. Letting out: the network privacy controls, all on the
default session's one web-request owner. `net-handlers.ts` holds the three handlers (`Sec-GPC` and `DNT`
headers, third-party cookie stripping, the HTTPS upgrade); `privacy-headers.ts`, `cookie-policy.ts` and
`https-only.ts` are their pure decisions, `site-of.ts` the registrable-domain rule they share. A failed upgrade
is followed by `https-fallback.ts` (the per-tab record), `https-fallback-runner.ts` (the tab's events) and
`https-state.ts` (this run's exemptions), and ends in the sheet `https-warning-overlay.ts`
([`../../renderer/overlay/https-warning/`](../../renderer/overlay/https-warning/)). `secure-dns.ts` maps the
Secure DNS choice to the resolver's options, and `storage-access.ts` answers the two storage-access permissions
from the cookie choice. `install-privacy-net.ts` is the installer `../shell/shell-installers.ts` runs at start.

**What it depends on.** `electron` (types: the sessions cleared; the installer and the runner use it directly);
[`../sessions/`](../sessions/) (the web-request owner and the site-asker registry), [`../overlays/`](../overlays/)
(`tab-slots.ts`, the overlay types), [`../../protocols/`](../../protocols/) (which names the verifier routes) and [`../dev/eth-resolver.ts`](../dev/eth-resolver.ts)
(this run's developer names);
[`../history/`](../history/) and [`../zoom/`](../zoom/) (what is forgotten through them);
[`../pages/internal-ipc.ts`](../pages/internal-ipc.ts) (the shape of a page's domain).

**What it must never import.** [`../shell/`](../shell/), except `install-privacy-net.ts`, which takes
`ShellInstaller` from it as a type, and `https-fallback-runner.ts`, which takes `WindowRegistry` as a type.

**Owner stream.** `shell`.

**Electron dependence.** `clear-data.ts` receives its sessions as arguments and is testable without Electron;
which sessions there are is decided by [`../pages/start-internal-pages.ts`](../pages/start-internal-pages.ts).
The network controls decide in plain functions and meet Electron only in `install-privacy-net.ts` (the owner's
registrations, `configureHostResolver`) and in the events `https-fallback-runner.ts` listens to.

## Design notes

**A time range applies to history only.** Electron clears a session's data by type and origin, with no time range,
so site data and the cache are all or nothing, and the page says so.

**An app's storage is a separate choice, only for a cache-served app.** Such an app keeps working data (a
signed-in session, a local database) in its own session, so clearing "cookies and site data" never reaches it;
choosing App data clears every cache-served app's own session instead, leaving the files an app saved in its
own folder, its permissions and its installed code untouched. A granted-without-install app has no session of
its own: its storage sits in the same session ordinary websites use, so "cookies and site data" reaches it and
App data does not.

**One part failing does not stop the others.** The result names what could not be cleared.

**The network controls cover the default session only.** That is where ordinary tabs and network-served apps
run. Extension pages and `orivon:` pages are never filtered (the filters name `http` and `https`, and a request
whose top document is not a web page is treated as first party), and an app's own partition is not covered.

**Every handler reads its setting per request.** A choice in Settings therefore applies to the next request
with no re-registration, and a handler whose setting is off returns what it was given, which the owner turns into
a bare `{}` (headers untouched). Handlers register on the owner, never on `session.webRequest`: a second
registration there would silently replace the owner's listener and silence the extensions'.

**Third-party cookie blocking works on the wire, not in the page.** The `Cookie` request header is removed from a
cross-site request and `Set-Cookie` from its response (the second found by the request id remembered at the
first, 2,000 at most). A script inside a cross-site frame can still read and write `document.cookie`: no
Electron API reaches that, and the `--test-third-party-cookie-phaseout` switch has no effect in this build. A
request whose top document cannot be read is left alone, so a failure to place a request never breaks it.
Handler order (signals and cookies at 20, after the sign-in identity headers at 0 and before the verifier's
stamp, which runs last) is *provisional*: whether an extension's request rule could put a stripped header back
depends on it, and the answer comes with those rules.

**HTTPS-only upgrades main-frame navigations only.** Mixed content is Chromium's own rule. What is left alone:
loopback, private and link-local addresses, single-label names and a network's own suffixes (`.local`, `.lan`,
`.internal`, `.home.arpa`), `.localhost`, the names a protocol routes to the verifier (which includes the
developer `.eth` names), and a host the person chose to continue to, until Orivon exits. A named host loses its
port in the upgrade (it would point HTTPS at a plain-HTTP port), an IP address keeps its own. A load of the
upgraded address that fails for any reason but a cancelled load or a name that does not resolve ends in the sheet; the
same address upgraded twice within five seconds (a server that sends HTTPS back to HTTP) is cancelled and
also ends in the sheet, so it cannot loop. "Continue" exempts the host and opens the address main stored for that
tab; the sheet carries no address.

**The sheet does not close on navigation.** The overlay host's own navigation close fires when the tab's
address changes to the failed one, which would dismiss the sheet as it opens. `https-fallback-runner.ts` ends it
when the tab starts loading another page, and the error page's own navigation does not count.

**Secure DNS leaves the resolver alone while it is off.** Electron's built-in resolver is on by default only on
macOS, so `off` is applied at launch there and nowhere else; any other choice turns the built-in resolver on
and sets the mode (and the provider, for the two named ones). Names that `--host-resolver-rules` maps (the
`.eth` names, a test's fixtures) are answered by those rules first and never reach the provider.

**Storage access follows the cookie choice and never prompts.** The two permissions are answered only for a tab:
allowed while every cookie is allowed, refused while third-party cookies are blocked. Chromium does not route a
`requestStorageAccess()` call through the permission handlers in this build, so this decides only what the
handlers are asked.
