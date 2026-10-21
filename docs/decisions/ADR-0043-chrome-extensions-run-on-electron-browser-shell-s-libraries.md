# ADR-0043: Chrome extensions run on electron-browser-shell's libraries, vendored

- **Status:** accepted
- **Date:** 2026-09-29
- **Type:** architecture
- **Decided by:** owner, for reusing electron-browser-shell and for turning native messaging off;
  AI recommendation, accepted by default, for vendoring and for what Orivon's loaded copy strips.

## Decision

Orivon runs ordinary Chrome extensions through Electron's own extension support plus two
libraries from electron-browser-shell, kept as source under `vendor/`:
`electron-chrome-extensions` (GPL-3.0), for the `chrome.*` APIs Electron lacks (`action`,
`tabs`, `windows`, `contextMenus`, `cookies`, `notifications`, `webNavigation`, `commands`,
`permissions`), and `electron-chrome-web-store` (MIT), for installing and updating from the
Chrome Web Store. Each `UPSTREAM.md` names the upstream commit and lists every patch.

Orivon never loads an extension's own folder. It writes a copy whose manifest has
`nativeMessaging` and every `webRequest*` and `declarativeNetRequest*` permission removed, and
the `declarative_net_request` key moved out, and records what it removed. Every copy carries a
`key`, so its id is stable across updates. No extension gets file access.

## Context

The owner asked for extensions on every page, and for the newest Chrome (MV3) extensions to work,
reusing electron-browser-shell rather than writing the missing APIs again. Measured on Electron
44 (`docs/planning/spike-results/extension-real-probe.json`): on bare Electron, the service
workers of uBlock Origin Lite, Dark Reader, Bitwarden and MetaMask all die at start on missing
`tabs` and `webNavigation` events; with `electron-chrome-extensions` active, Dark Reader and
Bitwarden run and their popups render.

## Alternatives considered

- **The libraries from npm.** The published `electron-chrome-extensions` is 4.9.0 (2025-07),
  behind upstream's Electron 44 update. It starts native-messaging hosts with
  `child_process.spawn` and has no option to turn that off, and `electron-chrome-web-store`
  checks no CRX signature. Patching the published bundle would mean patching minified output on
  every upgrade.
- **Writing `action`, `tabs` and `windows` over Orivon's tab manager.** About 3,000 lines that
  already exist, work and track Electron.
- **An Orivon-only extension format.** It has no ecosystem: nothing a person already uses.

## Reasoning

Vendoring keeps a mature component (Rule 6) and makes the two changes Orivon cannot do without
visible in source: native messaging starts desktop programs, native code outside the broker,
so its code is deleted; and every CRX a store install or update downloads goes through a
verifier Orivon supplies, which requires the developer's signature and the Web Store's.

The loaded copy's stripped permissions are forced by a measurement, not a preference
(`docs/planning/spike-results/extension-netfetch-probe.json`): with either network permission
present, Chromium proxies the session's URL loader, which bypasses `protocol.handle` and crashes
the main process on the first `net.fetch` on that session, in 10 of 10 runs without an embedder
`webRequest` listener. Orivon calls `net.fetch` on the default session. What an extension loses
there is to be served by Orivon's own request-filtering engine, on the one `webRequest` listener
per event Orivon owns; not built yet.

## Consequences

- `vendor/` holds third-party source in its upstream shape. `check:size` and `check:comments`
  skip it; `check:secrets` does not; its TypeScript checks under `vendor/tsconfig.json`.
- An upgrade re-copies upstream and re-applies the patch list, which each `UPSTREAM.md` keeps
  short and exact.
- GPL-3.0 code is combined with Orivon's AGPL-3.0-only, which GPLv3 section 13 permits.
- An action popup is a child `BrowserWindow`, as the library makes it.
- `chrome.runtime.connectNative` fails with a clear error. Password managers that need a
  desktop program lose that feature.
- Until Orivon's request-filtering engine serves them, an extension's `declarativeNetRequest`
  and `webRequest` rules do nothing, and the extension's details on `orivon://extensions` say so.

## Reversibility

- **Cost to reverse:** moderate. The library sits behind `src/main/extensions/`; replacing it
  means writing its APIs.
- **What would make us revisit:** Electron implementing `chrome.action` and `tabs` events
  itself, or the library stopping to track Electron releases.
