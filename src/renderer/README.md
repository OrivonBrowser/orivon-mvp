# `src/renderer/`: the browser chrome UI

**What lives here.** Five entries, plain vanilla-TS pages with no framework. Tied to Electron,
entirely.

| Entry | What it is |
|---|---|
| (top level) | The chrome view: tab strip (sharing its row with the native window buttons), toolbar and bookmarks bar, in its own `WebContentsView` above the active tab |
| [`newtab/`](newtab/) | The new-tab dashboard: ordinary content in a fresh tab's own view (`src/main/shell/tabs.ts`'s `createTab()`), not part of the chrome |
| [`settings/`](settings/) | The all-sites permissions popup: every app and its grants, revoke-only |
| [`site-info/`](site-info/) | The per-site popup: connection row, this site's switches, its Web3 Score and site data pages |
| [`intro/`](intro/) | The welcome screen, a full-window view over the shell (`src/main/shell/intro-view.ts`) |

**What it depends on.** The chrome view on `src/preload/shell.ts`'s commands, and `newtab/` on
`src/preload/newtab.ts`'s, degrading to plain markup outside a fresh tab. `intro/` has no
preload: it reports "Enter Orivon" through its URL hash, which `intro-view.ts` watches.
`settings/permissions-view.ts` imports [`src/protocols/builtin.ts`](../protocols/builtin.ts)
for pure string work (showing `ipfs://<cid>` as an address).

**What it must never import.** `electron`, `node:*`, or anything under [`src/main/`](../main/).
This is a sandboxed renderer with no Node; reaching for it means the logic belongs in main.
Type-only imports from `src/main/shell/tabs.ts` and `src/main/browsing/bookmarks.ts` are fine:
`verbatimModuleSyntax` erases them.

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
matching `orivon-browser-v2` ported from lucide (ISC), credited in `icons.ts`. A control with no
behaviour yet ships `disabled` with an honest `title`, never omitted or silently clickable
(A32).

**Visual reference only, never code:** `orivon-browser-v2` (the prior prototype at
`<prior-mvp>`) and `webtorrent-desktop` (ADR-0002). What is reused is v2's measured colours,
dimensions and icon shapes, not a line of its code.
