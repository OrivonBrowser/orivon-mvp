# `src/renderer/chrome/`: the chrome view's features

**What lives here.** The chrome view (`../index.html`, `../main.ts`) split by feature. Tied to
Electron, entirely: it runs in the chrome's `WebContentsView` on `src/preload/shell.ts`'s `orivonShell`.

| File | What it is |
|---|---|
| `context.ts` | `ChromeModule`, `ChromeContext`, `TabDecorator`; the state every module reads; `must`, `hasSite`, `anchorFor` |
| `modules.ts` | `CHROME_MODULES` and `TAB_DECORATORS`, one line per feature, and `dispatchShellEvent` |
| `tab-strip.ts` | the tabs (pinned ones in front, the rest in one scrolling run, `#tab-scroll`), the new-tab button, the empty tail, the cross-window drop mark |
| `tab-badges.ts` | a tab's pinned look, tooltip, accessible name and speaker badge; a `TabDecorator` |
| `tab-crashed.ts` | a crashed tab's mark; a `TabDecorator` |
| `contain.ts` | `contained` and `runDecorators`: one feature's throw is logged and the rest run |
| `tab-search-button.ts` | the button at the strip's right end that opens tab search |
| `navigation.ts` | back, forward, reload, the address bar |
| `address-suggest.ts` | the address field's dropdown from the field's side: what is typed, the arrows, Enter and Escape (the rules are in `address-suggest-model.ts`) |
| `address-display.ts` | the unfocused address over the input: the connection mark and the address in two tones (`address-format.ts` splits it) |
| `reload-stop.ts` | Reload becomes Stop after 150 ms of loading |
| `home-button.ts` | the Home button, shown while `toolbar.home` is on |
| `prompt-anchor.ts` | reports the address pill's rectangle to main (`prompt.anchor`), so a prompt can open under it |
| `site-badges.ts` | the Web3 Score shield and mark, the permissions key |
| `site-access-chip.ts` | the mark in the address bar for a page that asked for the camera, a location or another permission; it opens the review bubble |
| `cluster.ts` | the bookmark star, the zoom chip, the all-sites button, the profile chip, the menu button |
| `bookmarks-bar.ts` | the row under the toolbar: the bar's items, folder menus, the overflow button, the right-click menu |
| `bar-overflow.ts` | pure: which items fit, where an arrow key goes, what an event from main is worth |
| `bar-drag.ts` | drag to reorder the bar, or to file an item in a folder |
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
anything transient lives outside `.tab`.

**Modules keep their DOM in the factory's closure, not at module scope,** so importing a module
touches no `document` and a unit test can load the registry in Node.
