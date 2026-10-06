# `src/main/launch/`: which browser this process is

**What lives here.** How a process finds out whether it is the default profile, another profile or a
private session (`ADR-0042`), and what follows from that. `launch-context.ts` reads the command line;
`launch-request.ts` is what a start asks for (open the addresses, a new window, a new private window) and the check
on a request that arrives from another process; `local-operand.ts` reads an operand that names a file on this computer (a
`file:` URI, or an existing path read against the directory the start was made in); `start-launch.ts` runs first of all, points the data directory at the
right place and steps aside if that profile is already open; `profile-store.ts` is the profiles (one directory each, with a `profile.json`);
`private-session.ts` makes, marks, removes and sweeps the directories of private sessions;
`pid-liveness.ts` is the one check both it and `profile-store.ts` use to tell a marker's process from one
the OS has since reused its pid for;
`public-seed.ts` is the one list of what a new profile or a private session is given from the default profile;
`peer-spawn.ts` starts another Orivon process; `profiles-service.ts` is what the rest of the shell asks:
this process's own profile, the list, changes to it, and "open"; `profiles-domain.ts` is what the Profiles,
Private and Settings pages may ask of it.

**What it depends on.** `node:fs`, `node:os`, `node:child_process`;
[`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts) (`profile-store.ts`'s
own writes); `electron` only as a type (`start-launch.ts` is handed the `app`).
[`../shell/`](../shell/) is never imported.

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or any store that reads the data
directory: the launch has to run before one exists.

**Owner stream.** `shell`.

**Electron dependence.** Everything but `start-launch.ts` is plain Node and would outlive a change of the
engine beneath it; `start-launch.ts` calls Electron's `app.setPath` and single-instance lock and is tied to it.

## Design notes

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
