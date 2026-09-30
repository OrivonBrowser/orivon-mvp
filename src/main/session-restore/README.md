# `src/main/session-restore/`: what was closed, and what was open

**What lives here.** The tabs and windows a person closed, kept so `Mod+Shift+T` can bring the last one back,
and the record of the windows that are open now, kept in `<userData>/session.json` so a later start can
continue from it. `tab-snapshot.ts` says what is written down about a tab, `closed-stack.ts` and
`closed-tabs.ts` are the stack and what fills it, `reopen.ts` brings an entry back and words the menu hint,
`session-types.ts` and `session-store.ts` are the file and its one reader, `session-recorder.ts` and
`session-hook.ts` write the open windows down, and `restore.ts` and `open-snapshot.ts` open saved windows
and tabs again (`fillTabs`, `restoreWindows`, `seedClosedStack`).

**What it depends on.** `electron` (`session-hook.ts`, and `WebContents` in `tab-snapshot.ts`);
[`../shell/`](../shell/) (types of tabs, windows and hooks; `tab-lifecycle.ts`);
[`../storage/`](../storage/) (the debounced write); [`../browsing/omnibox.ts`](../browsing/omnibox.ts)
(the one rule for which addresses a tab may open); [`../pages/internal-pages.ts`](../pages/internal-pages.ts).

**What it must never import.** [`../../renderer/`](../../renderer/) code. Not `src/main/sessions/`, which
is about what an Electron `Session` may do and is unrelated.

**Owner stream.** `shell`.

**Electron dependence.** `session-hook.ts` (the quit event) and the `WebContents` read in `tab-snapshot.ts`
are tied to it. The stack, the file format, the store, the recorder and the restore calls take plain
values and would outlive a change of the engine beneath them.

## Design notes

**An address written down is data, and is checked every time it is read.** The file is writable by anything
running as the person. `sanitizeSnapshot` applies the address bar's own rule (`sanitizeDirectUrl`) when a
tab is recorded, when the file is parsed and again when a tab is opened, and an internal page must be one
that exists. Nothing here opens a tab with the trusted path. A title is shown through the menu's text
escaping only.

**Only addresses and titles are kept.** A snapshot holds no form state and no scroll position: the back and
forward list is reduced to address and title before it leaves `tab-snapshot.ts`. A new-tab page, a private
start page, a `view-source:` page, a blob and `about:blank` are not recorded, because a tab would not open them.

**A window is built into the file when the file is written, not when it changes.** Windows and tabs change
many times a second while a page loads; the store asks the recorder for the current state at write time, and
a change that leaves the addresses, titles, pinned tabs and front tab as they were is not reported at all.
The write is throttled, not debounced, so a title that never stops changing still reaches the disk.

**The last window closing keeps the session; a quit freezes all of it.** On Linux and Windows the last window
closing ends the browser, and by then its tabs are closed: the recorder saves the window in its `close`, with
its tabs alive, and from then on the file is left alone. A quit freezes every window first (the recorder's
listener runs ahead of the one that holds the quit while stores flush) and sets `clean`. A window closing
while others stay open leaves the session and goes on the closed stack instead.

**A private session writes nothing.** Its store is a null store and `session.json` is not among the files a
private session copies. The closed stack is in memory in every case, so reopening works in a private window and
ends with the session.

**A reopened tab shows its old title until its page has one.** It is a tab signal (`restored-title.ts`), so the
strip reads the title at once and the page's own replaces it.
