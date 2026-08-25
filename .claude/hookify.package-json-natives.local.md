---
name: block-package-json-natives
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: package\.json$
  - field: content
    operator: regex_match
    pattern: ['\"](node-datachannel|utp-native|bufferutil|utf-8-validate|fs-native-extensions|better-sqlite3|sqlite3|node-pty|keytar|sharp|leveldown|classic-level|node-gyp|@parcel/watcher|webtorrent|webrtc-polyfill|@thaunknown/simple-peer)['\"]
---

**Native (or native-pulling) dependency written into package.json — blocked (Rule 8).**

`webtorrent` must not be a shell dependency: it transitively requires `node-datachannel`
(CMake + libdatachannel). Ship it as a pre-built app asset instead (`build-plan.md`, spike
check 2). For the others, find a pure-JS alternative or raise it with the owner.
