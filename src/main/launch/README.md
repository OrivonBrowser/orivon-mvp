# `src/main/launch/`: which browser this process is

**What lives here.** How a process finds out whether it is the default profile, another profile or a
private session (`ADR-0042`), and what follows from that. `launch-context.ts` reads the command line;
`launch-request.ts` is what a start asks for (open the addresses, a new window, a new private window) and the check
on a request that arrives from another process; `local-operand.ts` reads an operand that names a file on this computer (a
`file:` URI, or an existing path read against the directory the start was made in); `start-launch.ts` runs first of all, gives a run from source a name and data directory of its own (ADR-0057; the names are in `program-names.ts`), points the data directory at the
right place and steps aside if that profile is already open; `profile-store.ts` is the profiles (one directory each, with a `profile.json`);
`private-session.ts` makes, marks, removes and sweeps the directories of private sessions, and
`private-extensions.ts` gives a new one the extensions its opener allows in private windows, with a copy of their data;
`pid-liveness.ts` is the one check both it and `profile-store.ts` use to tell a marker's process from one
the OS has since reused its pid for;
`private-picture.ts` gives a new private session the new tab's picture of the profile that opened it, copied asynchronously because it can be 20 MB;
`public-seed.ts` is the one list of what a new profile or a private session is given from the default profile;
`peer-spawn.ts` starts another Orivon process; `profiles-service.ts` is what the rest of the shell asks:
this process's own profile, the list, changes to it, and "open"; `profiles-domain.ts` is what the Profiles,
Private and Settings pages may ask of it.

**What it depends on.** `node:fs`, `node:os`, `node:child_process`;
[`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts) (`profile-store.ts`'s
own writes); [`../../protocols/builtin.ts`](../../protocols/builtin.ts) (`orivon-link.ts` serves an `ipfs://` address as the address bar does); [`../browsing/local-file-input.ts`](../browsing/local-file-input.ts) (which text names a local file:
`launch-request.ts` and `local-operand.ts`); [`../settings/settings-file.ts`](../settings/settings-file.ts) (the settings a private session held to a tunnel is written with: `private-session.ts` and `start-launch.ts`); [`../newtab/background-image.ts`](../newtab/background-image.ts) (the file name of the new tab's picture, which `private-picture.ts` copies into a private session);
[`../extensions/registry.ts`](../extensions/registry.ts), [`../extensions/extension-prefs.ts`](../extensions/extension-prefs.ts) and [`../route/site-partition.ts`](../route/site-partition.ts) (the pure parts `private-extensions.ts` reads the opener's extensions with); `electron` only as a type (`start-launch.ts` is handed the `app`).
[`../shell/`](../shell/) is never imported.

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or any store that reads the data
directory: the launch has to run before one exists.

**Owner stream.** `shell`.

**Electron dependence.** Everything but `start-launch.ts` is plain Node and would outlive a change of the
engine beneath it; `start-launch.ts` calls Electron's `app.setPath` and single-instance lock and is tied to it.

## Design notes

**A private session can be held to a tunnel from its first instant.** `--orivon-private-tunnel=nym` (parsed in `launch-context.ts`, only
with `--orivon-private`; any other value, or two, is a launch that cannot start, never "no tunnel") makes `ProfilesService.openPrivateNym` and the
"Open a private window with Nym" command. The opener writes the session's settings copy with the browser-wide tunnel on, Nym as the tunnel and
Nym allowed to run (`createPrivateDir`, through `settings-file.ts`'s `forceSettingsFile`: the file's version and checks, never edited text), and
the session writes the same again before anything reads the file (`start-launch.ts`), so what the route subsystem reads first, ahead of any
session or window, already holds the tunnel. A directory that cannot be set up is removed and nothing is started. From then on the process is held:
its settings store reads those three whatever a file says and refuses a change, its route store refuses an `off` entry, and a private window opened
from it is held too. The launcher menus (`../os/`) offer only the ordinary private window.

**A private session may carry an extension, as a copy.** `private-extensions.ts` runs after the directory is made: for each
extension that is enabled and allowed in private windows in the opening profile, it copies the extension's folder, a
registry and a prefs file of just those, and the extension's own storage (the stores behind `chrome.storage`, its
IndexedDB, its service worker cache) from the default session and the tunnel profiles' sessions. The prefs are an allowlist
of today's fields, so a choice added later (a camera answer) stays in the profile until it is named. Never copied: anything
shared with websites (`Local Storage`, cookies, history, caches, service worker registrations), a `LOCK` file or a link. The copy
is asynchronous, six files at a time, because an extension can hold tens of megabytes (and Windows scans each file): the window
that asked for the private one stays responsive, and `ProfilesService` starts the process only when the copy is done. A
session that made its own directory (a start with `--orivon-private`) copies in `index.ts` once Electron is ready, before
any subsystem reads the folder. Every file is copied on its own, because Windows may hold one open in the opener: a store
that cannot be copied whole is dropped, so the extension starts blank there, rather than corrupt; an extension whose own
files fail is left out; nothing stops the window from opening. Opened from a private window, the copy is made from that
window's directory in the same way.

**It runs before the data directory is read.** A store that had read the default directory could not be moved,
so `start-launch.ts` is called before the subsystems' `beforeReady`. No module reads the directory when it is
loaded, and a check would fail the build that started to.

**A second start hands over what it asks for, and stops.** The command line says what the start wants
(`launch-request.ts`): no address, or `--new-window`, is a new window; `--new-private-window` is a private session;
an address, a `file:` URI or a path that exists opens in the open window, and an operand that is none of those (a `mailto:`,
a path that is not there) only brings it forward. The request travels as the single-instance lock's additional data, and the running profile checks it as it
would any input from another process, reading anything malformed as a plain open of the addresses on the command
line. A request that reaches a browser still starting waits for its first window; a new window with no address then
only brings that window forward, so one launch never shows two. The second exits with status 0. A first start of a profile with `--new-private-window` has nothing to hand
over to: it releases the lock and runs as a private session, leaving the profile free for the next start. A
private session that made its own directory has a small program of its own remove it once the process has ended (on
Linux and macOS; Chromium writes as it quits, so a removal from inside would be undone), and the sweep at a later
start removes what is left, which on Windows is everything. A private session started
with `--orivon-private` has a directory of its own and takes no lock, so no second start reaches it.

**The activation token does not cross.** The desktop gives a launched program a token so the window it raises may
take the focus. In this Electron the token is consumed before the main script runs, and the running browser's
`second-instance` argv holds none, so a private session started from a launcher action cannot be passed one
(`docs/open-questions.md` A386).

**An `orivon:` link names a `.eth` name or an IPFS address, and the rest is refused** (`orivon-link.ts`,
[ADR-0094](../../../docs/decisions/ADR-0094-an-orivon-link-from-another-program-opens-a-eth-name-or-an-ipfs-address.md)).
The text comes from any program, so it is checked as an allow-list: a fixed alphabet and length, one `u=`, one decoding,
no control, space or bidirectional character, no `.` or `..` segment, and a target that is a `.eth` name (ASCII labels)
or an `ipfs://` or `ipns://` name. It leaves the parser as a web address, so a request carries nothing the check on a
request from another process does not already accept. Encode `&`, `#` and `%` inside `u=`: an unencoded `&` ends it. A
`flavour=` of the shape `FLAVOUR_ID` goes to `firstRunFlavourHint` only on the start a link made (the command line, or
an `open-url` before the first window); a bad or repeated one is dropped and the target still opens.

**Nothing after `--` is a switch.** The installer's link command ends the switches with `--`, so a link that carries
`--no-sandbox` or `--orivon-private` is only a link. Every reader of the command line (the launch, the switches a peer
inherits, the request) stops at the first `--`, as Chromium does.

**A peer is told only where its data is.** The data directory and sandbox switches of this launch are passed on and
nothing else: a debugger's port on the first process would be taken by the second.

**A directory named on the command line is one this browser made.** A private session's directory is removed when
it ends, so `start-launch.ts` refuses one that is not directly under the temp directory, named as the
system names a new one, and present.

**What a private session starts with is a short list** (`private-session.ts`, `public-seed.ts`): the settings,
keyboard shortcuts and search engines (`search-engines.json`, read and never written there) of the profile that opened it -- all preferences -- and the light client's checkpoint file,
which is public and without which a `.eth` name would fail once the shipped one is old. Zoom levels, a list of
sites, are never copied, and neither is the list of IPNS names visited that sits beside the checkpoint: it says
what the person has browsed. A new profile gets the same seed. Adding to the list is a change
to what the Private page promises.

**A profile says it is in use as soon as it holds the lock** (`start-launch.ts`), not when its first window is up:
until then another window of this browser would see it as free, and Delete would remove it from under a browser
that is starting. What a deletion that failed part way leaves (`.deleting-<id>`) is swept at the next start.
