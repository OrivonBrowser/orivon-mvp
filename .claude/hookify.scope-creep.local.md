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

**A vision feature not built yet (`docs/scope.md`, CLAUDE.md Rule 4).**

This text names something Orivon Browser does not have yet: Wasmtime/orivon-runtime,
Arweave, app store, wallet, auto-install (cut 2026-08-25), MKV/HEVC, Tor, UPnP, and Nostr
identity (NIP-07), which is an idea, not a build step. ENS, IPFS and DDOC are IN (build steps 4
and 6). A feature is built when a real app, a user or the success metric needs it.
Proceed if this is a limitation notice or a docs reference; otherwise name the need it serves,
and record it in `scope.md` as it lands.
