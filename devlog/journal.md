# Devlog journal — running capture

This file is the raw material for the Sunday devlog. It is append-only during the
week and compiled by `/devlog` into `devlog/updates/YYYY-MM-DD.md`, after which the
compiled week is cleared and a fresh week heading is started.

Three buckets per week:

- **Done / results** — technical outcomes worth telling the team. One line each.
- **In my head** — what the owner has been thinking about: doubts, direction changes,
  things circling that are not visible in commits. These become the voice-note cues.
- **Non-repo** — calls, Notion work, admin, anything outside this repository. Claude
  cannot see these, so the owner jots them here (or they get a placeholder on Sunday).

Mark anything that must not leave the team draft as `(Keep private)`.

---

## Week of 2026-10-05

### Done / results

- Wayland tab drags are now the browser's own drag and drop: the drag image follows outside the window and the other window marks the slot.
- A catalogue of what apps rely on now has a test per row; a broker change that breaks an app fails by name.
- test/ is grouped into areas, and a new capability, port or app bug has one README saying a row and a spec are required.
- All six Orivon apps are on IPFS, listed in Explore, and judged by Orivon Attila, our official Web3 Score provider.
- Explore now opens on Web3 sites alone: Orivon apps and Level 4 judgements, with Web2.5 sites in their own section.
- Every Explore card now carries its site's own icon tile, shipped with the app and loaded from its origin.
- An ipfs:// tab icon now waits out slow gateways instead of giving up at 5 s, the likely reason The Lounge showed none.
- Every ported app now shows visitors in other browsers a panel pointing them to Orivon; it stays hidden inside Orivon, and --no-orivon-hint removes it.
- Orivon asks to be the default browser from Settings, the welcome screen and weekly; the dock and taskbar offer New Window and New Private Window.
- CI's e2e now runs only the specs a change can reach, in parallel shards: minutes instead of forty.
- The shell's own pages no longer load from `file:`, and Electron's file-protocol fuse is off in every binary: local files can ship without extra privileges.
- Screen sharing works: a picker for tabs, windows and screens, Stop and indicators; only Orivon's own capture call is ever granted.
- Extensions get a real side panel: chrome.sidePanel works, the toolbar click or key opens it, and open() needs the person's own input.
- Publishing a GitHub release now builds Linux, Windows and macOS packages, launches each in CI, and attaches them.
- Orivon Attila now judges every Explore site: 62 more evaluations by CID, and its judging rules are written down with worked examples.
- FreeTube raised to Web3 Score Level 3: running YouTube's code is informed consent when the grant dialog says so and it's the app's purpose.
- Web3 Score levels now follow written definitions: FreeTube, The Lounge and Element reach Level 4, since users know their services are centralised.
- Explore opens on Web3 sites, marks each site Web2, Web2.5 or Web3, and lists 54 more live .eth sites.
- A page can now ask the person's chosen Web3 Score provider about a site, behind a declared trust.score grant the person answers.
- Local files open: each an origin of its exact path, asked with a double-press warning before it may use Orivon permissions.
- An installed app at a .eth name no longer changes silently: Orivon asks before switching builds; a Web3 Score counts only at its home.
- A .eth.limo or .eth.link address now opens the real .eth name, proven by Orivon instead of a gateway; a setting turns it off.
- Address bar: no more eaten first letter, a new tab types straight into it, and the first click selects the whole address.
- Installing from the Chrome Web Store no longer crashes Orivon; extension popups open under their icon on Wayland; new extensions start unpinned.
- Every e2e launch now waits for a ready window, ending the random first-launch failures that turned most CI runs red.
- Orivon run from source gets its own Linux dock entry: instant when open, and it can now be set as the default browser.
- Screen sharing on Wayland now shares the monitor you pick; two identical monitors had confused GNOME's restore of the choice.
- A page's CaptureController now binds to Orivon's share, so Meet's tab zoom and scroll work; its black presenter tile awaits a retest.
- Every ported app republished naming its home, <app>.orivonstack.eth: Attila's judged level counts only there, and in development under the same names.

### In my head

### Non-repo
