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

## Week of 2026-10-19

### Done / results

- An install whose checkpoint has aged out now fetches a fresh one from two beacon servers and uses it only if they agree.
- The opt-in usage report now names the app a tagged installer opened on first run; the notice re-asks.
- The update check now sees pre-releases; a bot refreshes the bundled checkpoint twice a week, and a release refuses one over seven days old.
- `orivon:` links open a .eth name or IPFS address from other programs; an installer named for an app opens that app on first run.
- The new tab gained hideable Featured tiles; the first permission question now says why.
- Releases submit themselves to the Microsoft Store, AUR and winget once credentials exist, with notes and a What's new page from the changelog.
- Every port was republished: ASGARDEX 1.46.1, Element 1.12.32, AirGap Vault 3.35.0, a landing outside Orivon, LICENSE files and build provenance.
- Ports gained an upstream-release watcher, attested builds and `orivon-port verify`, which rebuilds a published app and compares its bundle.
- CI now catches two branches that took the same ADR or decision number, and pr-watch settles decision-log conflicts by itself.
- Windows gets a one-line PowerShell install with no SmartScreen warning, and the Microsoft Store joins each release's file table.
- Private live telemetry dashboard on our server; telemetry now keeps each install's usage day by day, and the privacy notice says so.
- Attila now re-judges every watched .eth site that publishes a new build, every 3 hours: sandboxed Sonnet 5.5, then commit, publish, Telegram.
- Clicking Web2, Web2.5, Web3 or Web? opens the Web3 Score card with the current site's level marked.
- Extensions can use the camera and microphone after you allow them, asked per extension, and can run in private windows.
- Taking an app update now shows an "Updating" screen over its tabs and reloads them on the new version.
- Ports raise their version by themselves whenever a published build changes, so every republish reaches users as a real update.
- The Ethereum light client now starts on a computer whose clock is behind, using the servers' time for Helios alone; Settings says by how much.
- Releases carry only the plain downloads again; app-named installer copies are made separately, by hand, when wanted.
- TorSocks: an Orivon app running Tor (Arti in WebAssembly) as a SOCKS5 proxy for .onion sites, and onion services for articles, files and sites.
- Opening a .onion site through "Your proxy" is now an end-to-end test, and a spawned WebAssembly program's sockets have a catalogue row.
- Embedded .eth.limo content (images, scripts, fetches) now loads from the .eth name, checked; frames stay on the gateway.
- Attila and Explore now cover Orivon's own sites; a .eth.limo address is judged as its .eth name, lifting the website to Level 4.
- DecentraWiki: TiddlyWiki wikis anyone can edit; a pen opens an editor that publishes them on IPFS, checking each CID itself; judged Level 4.
- DecentraWiki publishes free with no account: Orivon's server pins each version 30 days on Filebase, checking the wiki and its CID.
- DecentraWiki's editor now runs Orivon's own IPFS node in its page and publishes from it; Orivon's node reads the wiki from there.
- TorSocks 0.1.4 publishes pictures, files, folders and websites; an onion that failed now loads once "Your proxy" is chosen for it.

### In my head

### Non-repo
