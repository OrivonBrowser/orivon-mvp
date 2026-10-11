# `src/renderer/chrome/`: the chrome view's features

**What lives here.** The chrome view (`../index.html`, `../main.ts`) split by feature. Tied to
Electron, entirely: it runs in the chrome's `WebContentsView` on `src/preload/shell.ts`'s `orivonShell`.

| File | What it is |
|---|---|
| `context.ts` | `ChromeModule`, `ChromeContext`, `TabDecorator`; the state every module reads; `must`, `hasSite`, `anchorFor` |
| `modules.ts` | `CHROME_MODULES` and `TAB_DECORATORS`, one line per feature, and `dispatchShellEvent` |
| `tab-strip.ts` | the tabs (pinned ones in front, the rest in one scrolling run, `#tab-scroll`), the new-tab button, the empty tail, the drop mark (another window's tab, or a native drag's slot). One element per tab, kept while the tab lives: a push patches the tabs that changed, moves an element only when the order changed, and runs the decorators on a changed tab only |
| `tab-badges.ts` | a tab's pinned look, tooltip, accessible name and speaker badge (a tab its site silenced reads "Muted by site settings" and the badge does nothing); a `TabDecorator` |
| `tab-crashed.ts` | a crashed tab's mark; a `TabDecorator` |
| `contain.ts` | `contained` and `runDecorators`: one feature's throw is logged and the rest run |
| `tab-groups.ts`, `tab-group-drag.ts` | a group's chip before its first tab, the group's colour on its tabs, hiding a collapsed group's tabs, and dragging a chip to move the group |
| `tab-sleeping.ts` | a sleeping tab's dimmed, ringed icon and the word "sleeping" in its tooltip and accessible name; a `TabDecorator` |
| `tab-search-button.ts` | the button at the strip's right end that opens tab search |
| `mac-window-buttons.ts` | on macOS in full screen, where the system hides them, the window's close, minimise and full-screen buttons, drawn where the system puts them |
| `navigation.ts` | back, forward, reload, the address bar |
| `address-suggest.ts` | the address field's dropdown from the field's side: what is typed, the arrows, Enter and Escape (the rules are in `address-suggest-model.ts`) |
| `search-mode.ts` | the Web3 / Web2 chip at the start of the address bar's trailing marks: shown while the field is in use or empty, it runs `search.toggleMode`; a change of engine asks the open dropdown (through `address-suggest.ts`'s `address-refresh` event) to name the new one |
| `address-display.ts` | the unfocused address over the input: the connection mark and the address in two tones (`address-format.ts` splits it), and when the field selects its text (`address-select.ts`: an entry selects, a window refocus keeps the caret) |
| `downloads-button.ts` | the downloads button in the cluster: a progress ring, a dot for what wants a look, the bubble on a click; `downloads-ring.ts` is its pure part |
| `home-button.ts` | the Home button, shown while `toolbar.home` is on |
| `reader-button.ts` | the book in the address pill while the page in front looks like an article; opens reader view |
| `password-key.ts` | the password button in the address pill: saved logins for this site, or an offer to keep the last sign-in |
| `prompt-anchor.ts` | reports the address pill's rectangle to main (`prompt.anchor`), so a prompt can open under it |
| `site-badges.ts` | the Web3 Score shield and mark, the permissions key |
| `site-access-chip.ts` | the mark in the address bar for a page that asked for the camera, a location or another permission; it opens the review bubble |
| `content-dot.ts` | a mark on the address bar's key for a site with JavaScript, images or sound switched off: an attribute on `site-badges`'s button, drawn by `styles/content-dot.css` |
| `sharing-chip.ts` | the mark in the address bar for a page that is sharing a screen, a window or a tab; it brings back the window's sharing bar |
| `popups-chip.ts` | the mark in the address bar for a page whose pop-ups were blocked, with a count from two; it opens the `popups-blocked` bubble |
| `side-panel-button.ts` | the cluster's side panel button: pressed while open, disabled in a window too narrow for a panel |
| `cluster.ts` | the bookmark star, the zoom chip, the all-sites button, the profile chip, the menu button |
| `bookmark-star.ts` | the star: opens the bookmark bubble under itself, and answers Mod+D with its rectangle |
| `bookmarks-bar.ts` | the row under the toolbar: the bar's items, folder menus, the overflow button, the right-click menu |
| `bar-overflow.ts` | pure: which items fit, where an arrow key goes, what an event from main is worth |
| `bar-drag.ts` | drag to reorder the bar, or to file an item in a folder |
| `panes.ts` | the chrome's four parts as keyboard panes (F6 steps through them, main takes over past either end), the toolbar's and strip's single Tab stop, Escape back to the page, the screen-reader announcement; a module and a `TabDecorator` |
| `roving.ts`, `roving-dom.ts` | pure: where an arrow, Home or End key moves in a row that shares one Tab stop; and the keydown wiring and stop bookkeeping over a container |
| `toolbar-button.ts` | `ctx.toolbarButton(...)`: a button in one of the three toolbar slots |

**Adding a feature.** A file here with a `create<Feature>(): ChromeModule`, one line in
`modules.ts`, and its rules in `../styles/<feature>.css` with one `@import` in `../style.css`. A
module's `init` runs once, `render` on every state push, and `event` on
`sendChromeEvent(window, name, payload)` from main. A button goes through `ctx.toolbarButton`, into
`#nav-slot`, `#address-slot` or `#cluster-slot`; a slot with nothing visible in it takes no room. A
call to main with arguments is `shell.act(name, payload)`, answered by
`src/main/shell/chrome-actions.ts`; a plain command is `shell.runCommand(id)`.

**What it depends on.** `../` (icons, drag helpers, `web3-shield.ts`) and, as
types only, `src/preload/shell.ts` and the main-side state types.

**What it must never import.** `electron`, `node:*`, or anything under `src/main/` except types.

## Design notes

**The strip is rebuilt on every push,** so a `TabDecorator` re-adds what it draws each time, and
anything transient lives outside `.tab`. The strip's keys are heard on `#tabrow` by delegation, and
the focused tab is found again by its id after a rebuild.

**Modules keep their DOM in the factory's closure, not at module scope,** so importing a module
touches no `document` and a unit test can load the registry in Node.
