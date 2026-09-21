# `src/renderer/`: the browser chrome UI

**What lives here.** Two entries, both plain vanilla-TS pages, no framework. The main one is the
chrome view: three rows, rendered in a dedicated `WebContentsView` above the active tab: the
tab strip (sharing its row with Electron's native window buttons), the toolbar (navigation, the
bookmark toggle, the omnibox, a right-hand icon cluster), and the bookmarks bar. Its look follows
`orivon-browser-v2`'s chrome; see **Visual reference** below. The second, [`newtab/`](newtab/),
is the new-tab dashboard: ordinary tab content
loaded into a fresh tab's own `WebContentsView`, not part of the chrome view at all; see
`src/main/tabs.ts`'s `createTab()`.

**Files.**

| File | What |
|---|---|
| `index.html` | The chrome view's DOM: three rows, and every icon that never changes as static inline SVG |
| `style.css` | Entry point: colour/size tokens, both themes, page-wide base rules, `@import`s the three below |
| `styles/tabstrip.css`, `styles/toolbar.css`, `styles/bookmarks.css` | One row each |
| `main.ts` | Renders `ShellState`, turns clicks/typing into `orivonShell.*` commands |
| `icons.ts` | Icons built at runtime (a tab's or bookmark's generic globe, a close/remove button); everything else is static markup; also imported by `newtab/main.ts` for its bookmark tiles |
| `bookmarks-view.ts` | Renders the bookmarks bar's dynamic list |
| `newtab/index.html`, `newtab/main.ts`, `newtab/style.css` | The dashboard: a search box, then a grid of app-shortcut and bookmark tiles, with its own small entry, separate from the chrome view |

**What it depends on.** `src/preload/shell.ts`'s exposed commands, over IPC, for the chrome
view; `newtab/main.ts` depends on `src/preload/newtab.ts`'s exposed commands the same way, and
degrades to plain unprivileged markup (no `window.orivonNewTab`) rather than throwing when
loaded outside a genuinely fresh tab; see that file's own header comment.

**What it must never import.** `electron`, `node:*`, or anything under
[`src/main/`](../main/). This is a sandboxed renderer with `nodeIntegration: false`; there is
no Node here, and reaching for it is a sign the logic belongs in main. (Type-only imports from
`src/main/tabs.ts` and `src/main/bookmarks.ts` are fine: they describe the shape of a state
push and are erased at build time by `verbatimModuleSyntax`.)

**Owner stream.** `shell`, build step 1, **done, maintenance only**.

**This is the only ESM tree in the repository.** Main and all three preloads are CommonJS; see
[`src/main/README.md`](../main/README.md).

**Layout constant, kept in three places on purpose.** `CHROME_HEIGHT` in
[`../main/window.ts`](../main/window.ts) is the sum of the rows below (native code and
CSS must agree on where tab content starts), and `scripts/smoke.mjs` carries its own copy to
assert against. **If you change one, change all three**, and re-run `npm run smoke`.

```
tab strip     36px   shares the row with Electron's native window buttons (titleBarOverlay /
                     macOS traffic lights) — reserved space for them is an approximation, not
                     a measurement; see open-questions.md A34
toolbar       40px
                     ────  76px  CHROME_TOP_ROWS — a profile with no bookmarks
bookmarks bar 28px   only rendered when there is a bookmark to render
                     ──── 104px  CHROME_HEIGHT
```

**The bookmarks bar is not always there, and that makes the chrome two heights, not one.** An
empty bar would be a row of controls that do nothing, so the row is hidden outright until the
list is non-empty. v2's static bar also had an apps-grid button and an "Other Bookmarks" folder;
neither is here, because neither has a model behind it, and "Other Bookmarks" could not be given
one without a folder feature nobody has scoped. The bar is the real list and nothing else. **The renderer hiding it is only half the
fix:** the tab content below starts where the chrome view *ends*, so main must shrink the view
too or the hidden row becomes a 28px band of empty chrome. `window.ts`'s `chromeHeight()` owns
that, reading the same `BookmarkStore` the state push comes from; `main.ts` sets
`data-bookmarks` on `<html>` from the same push, which drives `style.css`'s height override and
`styles/bookmarks.css`'s hide rule. The two are separate decisions made from one fact, so
`smoke.mjs` asserts them **together** (`bookmarksBarMatches`); either alone passes while the
feature is visibly broken.

**Reserving space for native window buttons.** `env(titlebar-area-*)` and
`navigator.windowControlsOverlay` both report empty/`false` for this shell's `BaseWindow` +
`WebContentsView` composition, confirmed empirically rather than assumed (`open-questions.md` A34).
`style.css`'s `[data-platform]` rules reserve a fixed inset instead, driven by `process.platform`
exposed read-only from `preload/shell.ts` (available even under `sandbox: true`) and written to
`document.documentElement.dataset.platform` at the top of `main.ts`, before first paint.

**Bookmarks are a real feature, not decoration**
(`docs/mvp-scope.md`, `ADR-0003`), and not in the original scope pass. `src/main/bookmarks.ts`
holds the list and persists it; this directory only ever renders what it's sent and asks main
to add/remove/open, the same pattern the tab strip already uses for tabs.

**Tabs show real favicons.** This directory only ever receives a `data:` URL
(or `null`) on `TabState.favicon` and renders it as an `<img>`, falling back to a generic globe
on `null` or a load failure; it never fetches a favicon itself. `src/main/favicon.ts` does the
actual fetching, capped and re-encoded to `data:`, specifically so this privileged view's CSP
can stay `img-src 'self' data:` rather than opening it to arbitrary third-party hosts.

**The address-bar dot has a third state, `.cached`, for a bundle served from Orivon's own local
cache (S4-6, `ADR-0007`).** A padlock reading "secure" for bytes read off disk, never touching
TLS, would be the false claim ADR-0007 names as unacceptable, so the dot cannot simply keep
guessing from the URL scheme once a tab is a pinned app. `main.ts`'s `updateAddressDot` still
paints the ordinary secure/insecure read first, synchronously (no page ever shows a blank dot
while a query is in flight), then asks main via `shell.deliveryProvenanceFor`, a separate round
trip from the toolbar permission key's `appPermissionsFor`, because the two answer
different questions (what this app may do, versus where its bytes came from), and upgrades to
`.cached` if the answer says so. The tooltip text is `"Running from local cache, pinned"`, quoted
directly from `ADR-0007`'s own wording rather than paraphrased, so the two can never read
differently. `src/main/delivery-provenance.ts` is deliberately built on the loader's own
protocol-handler registry, never the broker's `isRegisteredSync`, since the latter means only "a
manifest is registered," not "this origin's scheme is actually being answered from disk," and
the difference is exactly the false-claim risk this feature exists to avoid.

**Permissions and the Web3 Score are two different questions, so they are two different
controls in two different places.** The omnibox pill's trailing
slot is the **Web3 Score's alone**: that is the position `orivon-browser-v2` uses for it
(visual reference only), and a score is a claim *about* the page, which is what the inside of
the address bar is for. **Permissions live outside the pill**, first in the right-hand cluster,
nearest the address they describe: a grant is something the *user* hands out, not a property of
the site. The icon is a **key**, never a shield: a shield anywhere in this chrome means Web3
Score, and two shields meaning two unrelated things would be a confusion.

One consequence worth stating: there is **one** permission control, not two. It carries both
halves of queue item 4.4: the current tab's state (`.has-app` / `.has-warning`, painted from
`appPermissionsFor`) and the way into the full list, and it always passes the active tab's URL
to `openSettings`. A URL belonging to no app is harmless there: `settings/main.ts` finds no card
to scroll to and renders the list unscrolled, which is the ordinary open. The Web3 Score button
ships `disabled` with an honest title, because [`src/trust/`](../trust/) is build step 6 and
nothing scores an app yet (`open-questions.md` A32).

**Icons.** Hand-drawn inline SVG, no icon font, no library, no framework, matching the rest of
this codebase (Rule 8; `ADR-0002`, TypeScript only). Path data for the ones that visually match
`orivon-browser-v2` is hand-ported from lucide's icon set (ISC licence) onto lucide's own
default attributes, credited in `icons.ts`. A control with no v0 behaviour yet (extensions, the
sidebar, the identity/card slot, favorites, the Web3 Score, the menu) ships `disabled` with an honest
`title` rather than being omitted or left silently clickable (`open-questions.md` A32).

**Visual reference only, never code:** the prior prototype at
`<prior-mvp>` and `webtorrent-desktop`. Both are
[`ADR-0002`](../../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)
"visual reference only": their plumbing is stale and points at designs v0 rejects. v2 happens
to be a React + Tailwind + lucide-react app with no framework or dependency carried over here;
what's reused is its measured colours, dimensions and icon shapes, not a line of its code.
