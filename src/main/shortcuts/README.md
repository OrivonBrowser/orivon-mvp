# `src/main/shortcuts/`: the keys, and the commands they run

**What lives here.** Every command a key can run, and the rules for changing which key. `commands.ts`
is the one table of commands (id, label, category, default binding, fixed aliases, whether holding the
key repeats it, and whether an app's own tab keeps the key: `yieldToApp`, for find, print, save and the
like, which an app has of its own; and `pending`, a reserved row whose chord the dispatcher leaves to
the page until the feature lands); the key handling, the macOS menu, the main menu and the Shortcuts section of Settings all
read it, so a command exists in all of them or none. `accelerator.ts` turns a key press into a
chord and a chord into the text a person reads, `rules.ts` refuses a binding that would break typing
(no modifier, or a reserved chord such as Ctrl+C), and `shortcut-store.ts` keeps only the bindings
that differ from the defaults, in `<userData>/shortcuts.json`. `shortcut-service.ts` answers "which
command does this chord run", "what is bound to what", and the changes: set, clear, reset, trade two,
and record the next key pressed. `dispatcher.ts` listens for keys, `run-command.ts` and
`command-bus.ts` carry a command out on a window, `install-shortcuts.ts` puts the dispatcher on every
view the process makes, `page-key-ipc.ts` takes the one key an app's page reports back (a `Ctrl+F` the app left unhandled opens find), and `app-menu.ts` builds the macOS menu. `shortcuts-domain.ts` is what
Settings may ask of all this.

**What it depends on.** `electron` (`dispatcher.ts` types, `install-shortcuts.ts` and `app-menu.ts`);
[`../storage/`](../storage/) (the debounced write); [`../pages/internal-ipc.ts`](../pages/internal-ipc.ts)
(the shape of a page's domain); [`../browsing/bookmarks.ts`](../browsing/bookmarks.ts) (a command toggles a
bookmark); [`../shell/window-registry.ts`](../shell/window-registry.ts) (types only) and the top-level
`channels.ts`. Everything in `commands.ts`, `accelerator.ts` and `rules.ts` is plain data and pure
functions.

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/window.ts`](../shell/window.ts)
as values: a command reaches a window through the `ShellWindow` it is handed, and the shell reaches
these files, never the reverse. [`../../renderer/`](../../renderer/) code.

**Owner stream.** `shell`.

**Electron dependence.** The model (`commands.ts`, `accelerator.ts`, `rules.ts`, `shortcut-service.ts`,
`shortcut-store.ts`) does not depend on Electron and would outlive a change of the engine beneath
it. The key listener and the menu (`dispatcher.ts`, `install-shortcuts.ts`, `app-menu.ts`) are tied to it.

## Design notes

**Keys are read on `before-input-event`, not through a menu.** That event fires in the browser
process before the page sees the key, on every view (chrome, tabs, popovers, internal pages), so a
page cannot take a browser shortcut and a handled key never reaches it. A menu accelerator can take a
key before this runs and reaches only the windows that have a menu, which is why Linux and Windows have
no application menu and macOS's is display-only (its accelerators are switched off).

**A chord is matched by what it means, not always by the key it prints.** Letters and symbols match on
the character produced, so a remapped layout keeps Ctrl+T on the T it shows; digits match on the physical
key, because Shift changes the character but not the position a person means.

**Everything is suspended while a page has the screen.** A page in HTML fullscreen keeps every key
except the one that leaves it, which the browser handles itself; a shortcut that closed the tab
would give the page no way to be seen leaving.

**Extensions' commands are asked second.** `dispatcher.ts` takes an optional `extensionKeys` (the
table `../extensions/extension-commands-runner.ts` keeps): while a page records a key for one, it
takes the next chord first; and a chord no Orivon command holds goes to it unless the key is
auto-repeating or the window holds the screen. Orivon's own commands therefore always win, and this
directory imports nothing from `../extensions/`.

**Recording happens in main.** Settings asks to record; the next chord pressed in that page is
captured by the dispatcher, checked against the rules and the other commands, and sent back as an
event. There is one normaliser, and the page never interprets a keystroke.

**A conflict names the holder and offers a swap.** A chord another command holds as its own binding
can be traded; one it holds as a fixed alias cannot, since aliases stay whatever the command is
rebound to.
