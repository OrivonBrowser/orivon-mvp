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
- New windows open instantly, like a torn-off tab; a dock click on a running Orivon reaches the screen in half the time.
- A slow ipfs:// page now shows a "Loading from IPFS" screen until it is ready; any protocol can declare its own.
- Screen sharing on Wayland now shares the monitor you pick; two identical monitors had confused GNOME's restore of the choice.
- A page's CaptureController now binds to Orivon's share, so Meet's tab zoom and scroll work; its black presenter tile awaits a retest.
- Wayland sharing no longer reopens GNOME's dialog mid-share or flashes the camera; one "Window or screen" card opens the system's chooser.
- Every ported app republished naming its home, <app>.orivonstack.eth: Attila's judged level counts only there, and in development under the same names.
- Google sign-ins survive switching between the installed package and the source run: the source binary encrypts cookies as the package does.
- ipns:// keys now open, in a tab and as the default Attila provider; a dead public gateway had stalled every lookup past its deadline.
- Telemetry ships: the welcome asks with two equal buttons; it counts Web3, Web2.5 and Web2 time and public Web3 sites, unlinked.
- Our own telemetry server runs on the EU VPS: no IP kept, 12-month retention; a privacy notice in English and Italian explains everything.
- Global Privacy Control is on by default, sent by the engine itself to every page, frame and worker, ahead of California's 2027 rule.
- README rewritten for launch day: alpha, apps linked by `.eth` name, everyday-browser features up front, limits moved to `docs/known-limitations.md`.
- Telemetry site reports now carry the install ID, so spam can be excluded; reports also go at once on accept and on quit.
- Tab icons fixed: installed apps load theirs from the pin, multi-size `.ico` trimmed, Settings and other shell pages get their own icons.
- Second sign-out traced to `npm start` skipping the cookie fuse; it now sets the fuses before every launch, or refuses to launch.
- Telemetry now names the country from the time zone instead of EU/US, and both reports also go at browser start.
- After a privacy-notice change, Orivon asks for telemetry again at next start, saying what changed, instead of silently stopping.
- Report a problem: users describe a crash and see the full report, logs and optional crash dump before Send; our server receives it.
- Running from source is now its own program: separate profile and warm dock icon, beside the installed "Orivon Browser".
- New profiles start set up: uBlock Origin pinned, five Web3 bookmarks with icons, Attila scoring, and an "Orivon Featured" apps row on the new tab.

### In my head

- AI runs were slow from process, not code: a fast lane for small changes, related-only local tests, and a session time report.
- Asking for telemetry with a forced choice, not a pre-ticked box: legal in Europe, and people say yes almost as often.

### Non-repo
