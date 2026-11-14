# Chrome extensions, and naming a main-process crash

## Chrome extensions: the sandbox, service-worker preloads, and `net.fetch`

- **Playwright's `_electron.launch` adds `--no-sandbox` on Linux** unless the launch passes `chromiumSandbox: true`,
  and hides it from `process.argv` (`app.commandLine.hasSwitch` still sees it). `launchElectron({ sandbox: true })`
  in `test/support/launch-electron.mjs` passes it.
- **Electron runs no `service-worker` session preload under `--no-sandbox`.** An extension's worker then lacks
  everything electron-chrome-extensions injects (`tabs` events, `windows`, `action`), and real extensions die at
  start. Extension e2e tests launch sandboxed (`docs/open-questions.md` A289).
- **Sandboxed, a newly loaded extension's first worker still misses the preload**, every time;
  `src/main/extensions/extension-sw-preload-recovery.ts` checks each worker and reloads once.
- **`net.fetch` on a session that holds an extension declaring `webRequest` or `declarativeNetRequest` segfaults the
  main process** (Electron 44, 10 of 10 runs without an embedder `webRequest` listener). Orivon strips both from every
  extension copy it loads (`ADR-0043`).
- **Any embedder `session.webRequest` listener silences extensions' own `webRequest` and `declarativeNetRequest`**,
  and static dNR rules never apply at all.

## A main-process SIGSEGV has no names until the release's symbols are matched to the core

`coredumpctl` and `gdb` show Electron frames as raw offsets in the stripped binary. The symbols are in the release's
own asset, `electron-v<version>-linux-x64-symbols.zip` (GitHub releases of `electron/electron`), as
`electron.breakpad.syms`. Take the offsets of the frames from the core (`gdb -batch -ex bt` on the dump, minus the
mapping's load address), then find the `FUNC` record whose start and size cover each one: a record is
`FUNC [m] <start> <size> <param size> <name>`, all hex, so a short `awk` over the file does it. Frame #0 is the answer;
the first frame in `Run` of a `...Function` class names the extension API that was running (that is how a store
install's crash was traced to the native status handler of the Chrome Web Store page's API, reached after an extension
load made the renderer rebuild `chrome.*`). Match the symbols to the exact Electron version in
`node_modules/electron/package.json`; another version's offsets name a different function without any error.
