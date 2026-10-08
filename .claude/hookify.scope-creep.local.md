---
name: warn-out-of-scope-feature
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: ^(?:.*/)?(?:src|apps|packages)/.*\.(?:ts|tsx|json)$
  - field: content
    operator: regex_match
    pattern: (?i)\b(wasmtime|arweave|app[- ]?store|wallet|electron-updater|autoUpdater|mkv|matroska|hevc|tor\b|upnp|nat-pmp|nostr|nip-?07)\b
---

**A vision feature not built yet (`docs/roadmap.md`, CLAUDE.md Rule 4).**

This text names something Orivon Browser does not have yet: a WASM runtime, Arweave,
an app directory, a native wallet, auto-install, MKV/HEVC, Tor, UPnP, and Nostr identity (NIP-07), which is an
idea, not a build step. ENS, IPFS and DDOC ship (`docs/features.md`). A feature is built when
a real app, a user, a roadmap item or the success metric needs it. Proceed if this is a limitation notice or a
docs reference; otherwise name the need it serves, and record it in `docs/features.md` as it lands.
