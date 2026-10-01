# `src/renderer/`: the browser chrome UI

**What lives here.** Ten entries, plain vanilla-TS pages with no framework. Tied to Electron,
entirely.

| Entry | What it is |
|---|---|
| (top level) | The chrome view: `main.ts` starts the modules in [`chrome/`](chrome/) (tab strip, navigation, site badges, the toolbar cluster, the bookmarks bar; each a `ChromeModule`), and the drag helpers here (`tab-drag.ts`, and `strip-drag.ts` for the empty tail past the new-tab button in the manual drag mode, Linux/X11 only -- `src/main/shell/drag-mode.ts` decides), in its own `WebContentsView` above the active tab |
| [`chrome/`](chrome/) | The chrome view's features, one file each, and the three toolbar slots a feature puts a button in |
| [`newtab/`](newtab/) | The new-tab dashboard: ordinary content in a fresh tab's own view (`src/main/shell/tabs.ts`'s `createTab()`), not part of the chrome |
| [`permissions/`](permissions/) | The all-sites permissions popup: every app and its grants, revoke-only |
| [`site-info/`](site-info/) | The per-site popup: connection row, this site's switches, its Web3 Score and site data pages |
| [`intro/`](intro/) | The welcome screen, a full-window view over the shell (`src/main/shell/intro-view.ts`) |
| [`overlay/`](overlay/) | The one page every overlay shows: the main menu, and a page per feature that shows Orivon HTML above the page (`src/main/overlays/`) |
| [`split-frame/`](split-frame/) | The view behind the two panes of a split: the divider, the ring round the pane in use, and where a dragged tab would go |
| [`pages/`](pages/) | The shell's own pages, each a tab (`orivon://settings`, `history`, `bookmarks`, `profiles`, `private`, `extensions`), on the tokens and controls in `pages/shared/` |

**What it depends on.** The chrome view on `src/preload/shell.ts`'s commands, typed by that file's
`OrivonShell` so a dropped command fails the typecheck, and `newtab/` on
`src/preload/newtab.ts`'s, degrading to plain markup outside a fresh tab. `pages/` depends on
`src/preload/internal.ts`'s one `request` and `onEvent` and holds no capability of its own: it is
served with a CSP that allows no network. `intro/` has no preload: it reports "Enter Orivon"
through its URL hash, which `intro-view.ts` watches. `permissions/permissions-view.ts` imports [`src/protocols/builtin.ts`](../protocols/builtin.ts)
for pure string work (showing `ipfs://<cid>` as an address).

**What it must never import.** `electron`, `node:*`, or anything under [`src/main/`](../main/).
This is a sandboxed renderer with no Node; reaching for it means the logic belongs in main.
Type-only imports from `src/main/shell/tabs.ts`, `src/main/browsing/bookmarks.ts`,
`src/main/settings/schema.ts` and `src/preload/shell.ts` are fine: `verbatimModuleSyntax` erases them.

**The chrome document never changes its own URL, not even the fragment.** Main refuses every
command from a sender whose URL is not exactly the chrome's (`src/main/ipc/ipc.ts`'s
`isFromChrome`), so a hash change or `pushState` in the chrome would silence it.

## Design notes

**The chrome's height is kept in three places on purpose.** `CHROME_HEIGHT` in
[`../main/shell/window.ts`](../main/shell/window.ts), `style.css`, and `scripts/smoke.mjs`'s own
copy to assert against. **Change one, change all three**, and re-run `npm run smoke`.

```
tab strip     36px   shares the row with the native window buttons; their reserved
                     inset is an approximation, not a measurement (open-questions.md A34)
toolbar       40px   -> 76px CHROME_TOP_ROWS, a profile with no bookmarks
bookmarks bar 28px   only when there is a bookmark -> 104px CHROME_HEIGHT
```

**The bookmarks bar makes the chrome two heights.** The row is hidden until the list is
non-empty, and hiding it is half the fix: main must shrink the view too (`window.ts`'s
`chromeHeight()`), or the row becomes a 28px band of empty chrome. `main.ts` sets
`data-bookmarks` on `<html>` from the same push. `smoke.mjs` asserts the two together
(`bookmarksBarMatches`), since either alone passes while the feature is visibly broken.

**Bookmarks are a real feature** (`docs/scope.md`, ADR-0003): `src/main/browsing/bookmarks.ts`
holds and persists the list, and this directory renders what it is sent and asks main to add,
remove or open, as the tab strip does for tabs.

**Favicons arrive as `data:` URLs.** `src/main/browsing/favicon.ts` fetches, caps and re-encodes
them, so this view's CSP stays `img-src 'self' data:`; the renderer never fetches one itself.

**Icons are hand-drawn inline SVG**, no icon font or library (Rule 8;
[`ADR-0002`](../../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)), with paths
matching `orivon-browser-v2` ported from lucide (ISC), credited in `icons.ts`. The `svg`/`path`/
`circle`/`rect`/`line` primitives live in `pages/shared/svg-primitives.ts` and `icons.ts`
re-exports them for the rest of this directory -- under `pages/` rather than here so a page's own
dev-mode request for them stays inside the one prefix route.ts serves an `orivon://` page's module
graph from. `pages/shared/icons.ts` builds the shell's own pages' icons (Settings' nav, History's
marks) on the same primitives, drawn for those pages rather than ported. A control with no
behaviour yet ships `disabled` with an honest `title`, never omitted or silently clickable
(A32).

**The zoom chip sits at the right of the address pill, and is absent at the default level.** `main.ts` shows
`state.zoomPercent` when main sends one (`src/main/shell/window.ts`), and clicking it asks main to run the
`zoom.reset` command, so the chip and the keyboard reset one way.

**Visual reference only, never code:** `orivon-browser-v2` (the prior prototype at
`<prior-mvp>`) and `webtorrent-desktop` (ADR-0002). What is reused is v2's measured colours,
dimensions and icon shapes, not a line of its code.
