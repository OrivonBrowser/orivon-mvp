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

**Possible scope creep (`docs/mvp-scope.md`, CLAUDE.md Rule 4).**

This text names something that is OUT of the MVP by owner decision: Wasmtime/orivon-runtime,
Arweave, app store, wallet, auto-install (cut 2026-08-25), MKV/HEVC, Tor, UPnP, and Nostr
identity (NIP-07), which is an idea, not a build step. ENS, IPFS and DDOC are IN (build steps 4
and 6). Anything absent from the IN table in `mvp-scope.md` is out by default.
Proceed only if this is a limitation notice, a docs reference, or the owner has said so.
