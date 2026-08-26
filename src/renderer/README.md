# `src/renderer/` — the browser chrome UI

**What lives here.** The tab strip, toolbar and address bar — the browser's own interface,
rendered in a dedicated `WebContentsView` above the active tab.

**What it depends on.** `src/preload/shell.ts`'s exposed commands, over IPC.

**What it must never import.** `electron`, `node:*`, or anything under
[`src/main/`](../main/). This is a sandboxed renderer with `nodeIntegration: false`; there is
no Node here, and reaching for it is a sign the logic belongs in main.

**Owner stream.** `shell` — build step 1, **done**.

**This is the only ESM tree in the repository.** Main and both preloads are CommonJS; see
[`src/main/README.md`](../main/README.md).

**Layout constant, kept in two places on purpose.** `CHROME_HEIGHT` in
[`../main/window.ts`](../main/window.ts) is the sum of the three rows defined in `style.css`
(40 + 40 + 38 = 118). Native code and CSS must agree on where tab content starts. **If you
change one, change the other**, and re-run `npm run smoke`, which asserts the tab view's height
is the window height minus `CHROME_HEIGHT`.

**Visual reference only, never code:** the prior prototype at
`/home/jhon/git/orivon-browser-v2` and `webtorrent-desktop`. Both are
[`ADR-0002`](../../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)
"visual reference only" — their plumbing is stale and points at designs v0 rejects.
