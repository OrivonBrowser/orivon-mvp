# `src/main/flavour/`: a package tagged for an app

**What lives here.** What the first run of a new default profile does when the package was tagged for an app.
`flavours.ts` is the allowlist (`resources/flavours.json`) and how a tag is read from a file name, as pure functions.
`carriers.ts` reads where a tag can come from: the switch `--orivon-flavour=<id>` (`../launch/launch-context.ts`'s
`flavourSwitch`), the AppImage's own file name (`$APPIMAGE`) and `installer-name.txt`, which the Windows installer writes
beside the program. `first-run-flavour.ts` holds `applyFirstRunFlavour(id)`, the profile's `flavour.json` and `storedFlavourApp` (the app that file names, which the new tab's Start here card offers first);
`after-welcome.ts` holds work back until the welcome screen closes; `start-first-run-flavour.ts` is the one call
`../index.ts` makes.

**What it depends on.** `node:fs`, [`../newtab/`](../newtab/) (`setNewcomerPin`), [`../launch/launch-context.ts`](../launch/launch-context.ts)
(the switch), [`../shell/`](../shell/) (the welcome plan's type, the tabs), [`../default-profile/profile-start.ts`](../default-profile/profile-start.ts)
(whether the profile was new), [`../../../resources/flavours.json`](../../../resources/flavours.json).

**What it must never import.** `electron` (`start-first-run-flavour.ts` takes what it needs from the shell services), and
the [`../consent/`](../consent/), [`../permissions/`](../permissions/) and [`../../broker/`](../../broker/) code: a tag
decides which app opens, never what it may do.

**Owner stream.** `shell`.

**Telemetry reads one thing from here.** `reported-flavour.ts` hands the opt-in usage report the stored id when it is on the list, and
nothing otherwise; it writes nothing and decides nothing else.

**Electron dependence.** None: file names, a switch and two small files in the profile.

## Design notes

**A tag only selects.** The id must be on the allowlist; an address, free text, an unknown or malformed id, an id given twice
and a name with two tags all give the plain first run, silently. The allowlist's `app` equals the `domain` of the port's
`orivon.json`, which the release workflow checks.

**`applyFirstRunFlavour(id)` is the one seam.** It validates against the allowlist, applies only when the process is the default
profile in an ordinary window and the profile was new when it started, applies once (the stored `flavour.json` holds the id
and when, and stops a second id, from any carrier, in this process or a later one), and returns whether it applied. A new
carrier calls it; it does not repeat the rules.

**What applying does, and only this.** It opens `ipfs://<app>` in a new tab through the same navigation a tile on the new tab
uses, after the welcome screen has closed (at once when the launch shows none), and gives the profile's Featured row its
newcomer pin under the app's name. It grants nothing and answers no question: the app's own consent prompt appears as for any
visit.

**The installer's file is read, not parsed, by the installer.** `$EXEFILE` is written verbatim; `flavours.ts` reads it, and a
name that carries no tag (a plain installer, a name a download manager changed) is no carrier.
