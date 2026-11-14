---
name: warn-out-of-scope-feature
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: ^(?:.*/)?(?:src|apps|packages)/(?!tests/)(?:(?!/tests/).)*\.(?:ts|tsx|json)$
  - field: content
    operator: regex_match
    pattern: (?i)\b(arweave|app[- ]?store|wallet|electron-updater|autoUpdater|matroska|hevc|upnp|nat-pmp|window\.nostr|nip-?07)\b
---

**A feature not built yet (`docs/roadmap.md`, CLAUDE.md Rule 4).**

This text names one: Arweave (Later), an app directory and a native wallet (Expected next), an update
that installs itself (Expected next: today the check only asks), MKV or HEVC playback, UPnP port
mapping (`docs/known-limitations.md`), or `window.nostr` (NIP-07: `src/nostr/` is parked, an idea,
not scheduled). A feature is built when a real app, a user, a roadmap item or the success metric needs
it. Proceed if this is a limitation notice or a docs reference; otherwise name the need it serves, and
record it in `docs/features.md` as it lands.

Not gaps: ENS, IPFS, Swarm, DDOC and WebAssembly apps ship (`docs/features.md`), and Tor works as your
own SOCKS5 tunnel.
