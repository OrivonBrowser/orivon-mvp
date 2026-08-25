---
name: block-native-modules
enabled: true
event: bash
pattern: (npm|pnpm|yarn)\s+(i|install|add)\b.*\b(node-datachannel|utp-native|bufferutil|utf-8-validate|fs-native-extensions|better-sqlite3|sqlite3|node-pty|keytar|sharp|leveldown|classic-level|node-gyp|@parcel/watcher|fsevents|cpu-features|ssh2|canvas)\b
action: block
---

**Native module install blocked (CLAUDE.md Rule 8 / build-plan.md "Platform policy").**

Windows and macOS are supported via run-from-source (`git clone && npm install && npm start`).
Any dependency needing node-gyp, CMake or a C++ toolchain breaks that path silently.

- `webtorrent` and its native transitive deps (`node-datachannel` via `webrtc-polyfill`) are
  shipped as a **pre-built app asset**, never as a shell dependency.
- If a pure-JS alternative exists, use it. If not, stop and raise it with the owner.
- After any install, the `postinstall` check must find zero `binding.gyp` / `prebuilds/` under
  `node_modules`.
