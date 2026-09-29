# `vendor/`: third-party libraries, kept in their upstream shape

**What lives here.** Two libraries from [electron-browser-shell](https://github.com/samuelmaddock/electron-browser-shell),
each with its own `UPSTREAM.md` listing Orivon's patches by number (what changed, where, and the
reason), so an upgrade can re-copy upstream and re-apply the list:

| Folder | Package | Licence |
|---|---|---|
| [`electron-chrome-extensions/`](electron-chrome-extensions/) | Wires `chrome.*` into the shell: the extension host, the action popup, `chrome.cookies`/`chrome.tabs` host-access checks (`src/main/extensions/extension-host.ts`) | GPL-3.0 (`LICENSE-GPL`; the package is dual-licensed, `LICENSE-PATRON.md` is the other side Orivon does not use) |
| [`electron-chrome-web-store/`](electron-chrome-web-store/) | The Chrome Web Store install/update path Orivon's own verifier and install runner call into (`src/main/extensions/store-runner.ts`) | MIT (`LICENSE.md`) |

`electron-chrome-web-store/src/browser/crx3.proto` is Chromium's own file; its licence
(BSD-3-Clause) is [`electron-chrome-web-store/LICENSE-CHROMIUM`](electron-chrome-web-store/LICENSE-CHROMIUM).

Why each is here, not reimplemented: [`ADR-0043`](../docs/decisions/ADR-0043-chrome-extensions-run-on-electron-browser-shell-s-libraries.md).

**What it depends on.** `electron`, `node:crypto`, `node:events`, `node:fs`, `node:module`,
`node:os`, `node:path`, `node:stream`, `debug`, `adm-zip` and `pbf` (verified by grep over both
packages' `.ts` files) -- nothing from this repository.

**What it must never import.** [`src/`](../src/): this directory is upstream source, reformatted
only where its own `UPSTREAM.md` says so. A dependency runs the other way -- `src/main/extensions/`
and `src/preload/` reach into here, never the reverse.

**Tied to Electron**, entirely (Rule 5): both packages exist only to wire `chrome.*` and the
Chrome Web Store into an Electron session.

**Typechecked, not linted.** `npx tsc --noEmit -p vendor/tsconfig.json` checks this directory
under its own, deliberately looser settings -- the root tsconfig's stricter flags
(`exactOptionalPropertyTypes`, `verbatimModuleSyntax`) are not upstream's, and satisfying them
here would mean reformatting most of the vendored tree. `npm run check:size` and
`npm run check:comments` both skip this directory for the same reason (Rule 1 and the line-count
budget are Orivon's own authoring style, never upstream's); `npm run check:secrets` does not skip
it.

**Owner stream.** `shell`.
