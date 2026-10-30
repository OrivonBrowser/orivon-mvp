# `src/main/os/`: what the operating system is told about Orivon: links opened from other programs, the default-browser registration and its ask, launcher menus, shortcuts and sharing

**What lives here.** The decisions and the runners of seven things, and `windows-store.ts` (what a Microsoft Store install is: its AUMID read from the folder it runs from, and the registry text that says whether a packaged handler is this one). A link another program hands to a running macOS
app (`open-url.ts`: an http(s) address or an `orivon:open` link, read by `../launch/orivon-link.ts`), and a file the system hands it (`open-file.ts`: the open-file event joins the same queue as a second start's operands). Whether Orivon is the default browser and the call that makes it so (`default-browser.ts`, which on Linux also registers the three document types in `LINUX_DOCUMENT_TYPES`, its
runner, `os-domain.ts` for the Settings page). When Orivon asks to be the default browser (`default-browser-ask.ts`
is the rule over three facts and the clock; `install-default-browser-ask.ts` looks at it every hour). The entries a
dock or a taskbar shows for Orivon's icon (`launcher-tasks.ts`, `install-launcher-menu.ts`, and
`windows-taskbar.ts` for a run from source on Windows). The share commands, Copy link, Copy web link and Email link (`share.ts`,
`share-commands.ts`, `share-runner.ts`; `web-link.ts` is the rewrite Copy web link copies). What the clipboard gets when any address is copied from Orivon's own UI (`address-clipboard.ts`: the address as text, and as a link to its web form where it has one; `address-clipboard-runner.ts` is the write: `copyAddress` and `copyAddresses` reject when it fails, for the share commands, the address bar's copy and the QR sheet, which tell the person; `copyAddressLogged` and `copyAddressesLogged` log a failure for the menus and pages that wait for nothing). A site's shortcut: the file's text (`site-shortcut.ts`), where it is
written (`site-shortcut-runner.ts`), and the sheet that asks for it (`shortcut-open.ts`, `shortcut-overlay.ts`,
`shortcut-real.ts`). `menu-state.ts` says when the main menu greys those rows. `default-browser-test-seam.ts` is the
recording host a test build uses in place of the system.

**Tied to Electron, in the runners and the installers.** `default-browser-runner.ts`, `share-runner.ts`, `address-clipboard-runner.ts`,
`shortcut-real.ts`, `windows-taskbar-real.ts`, `install-launcher-menu.ts` and `install-default-browser-ask.ts` import
`electron` or a module bound to it; every other file takes what it needs through a host interface, so a unit test
never touches the machine. `createDefaultBrowserCheck` and `askPlace` are the parts of the ask that a test drives.

**What it depends on.** [`../shell/`](../shell/) (`ShellWindow`, `ShellServices`, `TabState`, the installer and
window-hook types, the question panel in [`../shell/question/`](../shell/question/), and `intro-view.ts`'s `isIntroShowing`, since the ask
waits for the welcome screen), [`../overlays/`](../overlays/)
(`OverlayDef`, and `tab-slots.ts`'s `hasAsk`), [`../shell/tab-partition.ts`](../shell/tab-partition.ts) (`appTabViews`, which tabs hold a registered app), [`../startup/restore-overlay.ts`](../startup/restore-overlay.ts) (the ask waits for the restore bar to
go), [`../page-tools/toast.ts`](../page-tools/toast.ts), [`../launch/launch-context.ts`](../launch/launch-context.ts)
[`../launch/local-operand.ts`](../launch/local-operand.ts) (which operand of an open-file event is a local file)
and [`../launch/peer-spawn.ts`](../launch/peer-spawn.ts) (the command that starts Orivon again, one home for it),
[`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts) (the ask's file).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).
Nothing a page or a link supplies reaches a command line or a file path unvalidated.

**Owner stream.** `shell`.

## Design notes

**Only an installed package registers, and only on a click.** A run from source would register the Electron binary,
and an AppImage moves, so `unavailableReason` answers from facts alone (the platform, how Orivon was started and the
desktop entry a choice would name) and the runner never calls the system there. The one exception is a Linux run
from source whose own entry, `orivon-source.desktop`, starts this checkout: a choice there names the entry, so it
registers that entry with `xdg-settings` and `xdg-mime`, the tools Electron's own calls run for `orivon.desktop`. A
test build never sees the entry, so an end-to-end run cannot change the machine's default; the answer says why, and Settings words it. Nothing registers at start-up:
the Settings button and the question are the two clicks that do. On Windows no
program may take the choice, so Make default opens Windows Settings and the answer is read again when the person
returns; macOS registers through `setAsDefaultProtocolClient`. Both paths are written from the platforms'
documentation and unverified on a real system (*provisional*, A328).

**In a Microsoft Store install nothing compares a path.** A packaged web-link handler is an AppX program id, so
`windowsStoreDefault` reads the person's `UserChoice` program id and that key's `Application\AppUserModelID` with
`reg query`, and compares it with the package's own AUMID (`windows-store.ts`). Make default opens the top of the
default-apps page, since a package has no `RegisteredApplications` name to select. Written from Microsoft's
documentation, unmeasured on a Store install (*provisional*, A410), which also lists what else here has not been
checked inside a package: the taskbar menu, the process's AUMID and a peer started with `peerCommand`.

**The first ask comes a beat after the first app has opened or on the second day of use, whichever is first, and each
later one a week after the last.** The clock starts the first time the check finds a window in use, so time on the
welcome screen and its telemetry popup does not count; a missing or corrupt file is a profile not seen yet. An app has
opened when a registered app's tab (the app-tab flag) finishes loading a page (`app-open-watch.ts`, which more than one listener may watch); the moment is kept
for this run only. The second day is the next calendar day on the wall clock after the one the profile was first seen
in use. "Don't ask again" is on every ask, the first included, and a clock set back is reset to now. The check looks at
the clock when the next ask falls due (at least hourly), when an app finishes loading, and asks the system only when a
question is due, because on Linux that is a spawned `xdg-settings check` that holds the main process. It asks only in
a visible window the person is using, with no welcome screen over it, no restore bar in it, and no sheet or prompt of
the active tab on screen or waiting (an app's consent question is one); otherwise it looks again every ten seconds, so
it can never fall back to a native box.

**A launcher entry is the program and a flag, never the switches of this run.** The system keeps the command past this
process, so `launcher-tasks.ts` builds it from `peerCommand` and the flag alone: a `--user-data-dir` or `--no-sandbox`
of today's launch would outlive its reason. The installed .deb carries the same two entries in its desktop entry; a
launcher written by hand adds them itself (`docs/development/setup.md`).

**A shortcut file is built from a page's own words, so every byte is cleaned or escaped.** `site-shortcut.ts` removes
control characters from the name (a line break would start a new line of the file, for example an `Exec=`), quotes every
`Exec=` argument, escapes the characters a quoted argument still reads specially, and doubles `%`. The file name is
`orivon-<slug>-<8 hex>.desktop`, built in main from the address; the sheet sends a name and a tick, never a path or an
address. The places it writes come from the host, which a test points at a temporary directory.

**Copy web link copies an address another browser opens, and is offered only where that differs from Copy link.** A `.eth`
name (`ipfs://name.eth/x`, `ipns://name.eth`, or the plain `https://name.eth` shown before the network is learned)
becomes `https://name.eth.limo/x`; an `ipfs://<cid>` becomes `https://<cidv1-base32>.ipfs.dweb.link/` (a CIDv0 is
converted, since a subdomain is lowercase); an `ipns://<key>` becomes `https://<key>.ipns.dweb.link/`. Path, query
and fragment are kept as written. A name or CID that cannot be one host label, a DNSLink domain, `bzz://`, Orivon
pages and `file:` have no web link, and their row is not offered (greyed with the reason in the main menu). Nothing is
requested: the address is only copied, and it says nothing of the page being verified, which only Orivon does. The
tab menu, the main menu and a link's right-click menu carry it, labelled `WEB_LINK_LABEL`.

**Email link asks first.** The address and the title are a page's words. They are percent-encoded into a `mailto:`
address, and the same question a page that opens a `mailto:` link is asked is put before the mail program starts.

**No shortcut from a private window.** A shortcut is a file left on the computer, which a private window must not do.
