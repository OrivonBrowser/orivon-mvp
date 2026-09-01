# `src/renderer/` — the browser chrome UI

**What lives here.** Two entries, both plain vanilla-TS pages, no framework. The main one is the
chrome view: three rows, rendered in a dedicated `WebContentsView` above the active tab — the
tab strip (sharing its row with Electron's native window buttons), the toolbar (navigation, the
bookmark toggle, the omnibox, a right-hand icon cluster), and the bookmarks bar. Restyled
2026-08-28 to match `orivon-browser-v2`'s chrome — see **Visual reference** below. The second,
[`newtab/`](newtab/) (added the same day), is the new-tab dashboard — ordinary tab content
loaded into a fresh tab's own `WebContentsView`, not part of the chrome view at all; see
`src/main/tabs.ts`'s `createTab()`.

**Files.**

| File | What |
|---|---|
| `index.html` | The chrome view's DOM: three rows, and every icon that never changes as static inline SVG |
| `style.css` | Entry point — colour/size tokens, both themes, page-wide base rules, `@import`s the three below |
| `styles/tabstrip.css`, `styles/toolbar.css`, `styles/bookmarks.css` | One row each |
| `main.ts` | Renders `ShellState`, turns clicks/typing into `orivonShell.*` commands |
| `icons.ts` | Icons built at runtime (a tab's or bookmark's generic globe, a close/remove button) — everything else is static markup; also imported by `newtab/main.ts` for its bookmark tiles |
| `bookmarks-view.ts` | Renders the bookmarks bar's dynamic list |
| `newtab/index.html`, `newtab/main.ts`, `newtab/style.css` | The dashboard: a search box, then a grid of app-shortcut and bookmark tiles — its own small entry, separate from the chrome view |

**What it depends on.** `src/preload/shell.ts`'s exposed commands, over IPC, for the chrome
view; `newtab/main.ts` depends on `src/preload/newtab.ts`'s exposed commands the same way, and
degrades to plain unprivileged markup (no `window.orivonNewTab`) rather than throwing when
loaded outside a genuinely fresh tab — see that file's own header comment.

**What it must never import.** `electron`, `node:*`, or anything under
[`src/main/`](../main/). This is a sandboxed renderer with `nodeIntegration: false`; there is
no Node here, and reaching for it is a sign the logic belongs in main. (Type-only imports from
`src/main/tabs.ts` and `src/main/bookmarks.ts` are fine — they describe the shape of a state
push and are erased at build time by `verbatimModuleSyntax`.)

**Owner stream.** `shell` — build step 1, **done, maintenance only**.

**This is the only ESM tree in the repository.** Main and all three preloads are CommonJS; see
[`src/main/README.md`](../main/README.md).

**Layout constant, kept in three places on purpose.** `CHROME_HEIGHT` in
[`../main/window.ts`](../main/window.ts) is the sum of the three rows below (native code and
CSS must agree on where tab content starts), and `scripts/smoke.mjs` carries its own copy to
assert against. **If you change one, change all three**, and re-run `npm run smoke`.

```
tab strip     36px   shares the row with Electron's native window buttons (titleBarOverlay /
                     macOS traffic lights) — reserved space for them is an approximation, not
                     a measurement; see open-questions.md A27
toolbar       40px
bookmarks bar 28px
                     ────
                     104px total
```

**Reserving space for native window buttons.** `env(titlebar-area-*)` and
`navigator.windowControlsOverlay` both report empty/`false` for this shell's `BaseWindow` +
`WebContentsView` composition — confirmed empirically, not assumed (`open-questions.md` A27).
`style.css`'s `[data-platform]` rules reserve a fixed inset instead, driven by `process.platform`
exposed read-only from `preload/shell.ts` (available even under `sandbox: true`) and written to
`document.documentElement.dataset.platform` at the top of `main.ts`, before first paint.

**Bookmarks are a real feature, not decoration.** Owner override, 2026-08-28
(`docs/mvp-scope.md`, `ADR-0003`) — not in the original scope pass. `src/main/bookmarks.ts`
holds the list and persists it; this directory only ever renders what it's sent and asks main
to add/remove/open, the same pattern the tab strip already uses for tabs.

**Tabs show real favicons.** Added 2026-08-28. This directory only ever receives a `data:` URL
(or `null`) on `TabState.favicon` and renders it as an `<img>`, falling back to a generic globe
on `null` or a load failure — it never fetches a favicon itself. `src/main/favicon.ts` does the
actual fetching, capped and re-encoded to `data:`, specifically so this privileged view's CSP
can stay `img-src 'self' data:` rather than opening it to arbitrary third-party hosts.

**Icons.** Hand-drawn inline SVG, no icon font, no library, no framework — matching the rest of
this codebase (Rule 8; `ADR-0002`, TypeScript only). Path data for the ones that visually match
`orivon-browser-v2` is hand-ported from lucide's icon set (ISC licence) onto lucide's own
default attributes, credited in `icons.ts`. A control with no v0 behaviour yet (extensions, the
sidebar, the identity/card slot, favorites, shields, the menu) ships `disabled` with an honest
`title` rather than being omitted or left silently clickable — `open-questions.md` A25.

**Visual reference only, never code:** the prior prototype at
`/home/jhon/git/orivon-browser-v2` and `webtorrent-desktop`. Both are
[`ADR-0002`](../../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)
"visual reference only" — their plumbing is stale and points at designs v0 rejects. v2 happens
to be a React + Tailwind + lucide-react app with no framework or dependency carried over here;
what's reused is its measured colours, dimensions and icon shapes, not a line of its code.
