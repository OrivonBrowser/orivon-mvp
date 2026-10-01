# `src/main/downloads/`: the files tabs download

**What lives here.** Every download a tab makes, from the moment its save path is chosen to the row on
`orivon://downloads`. `download-service.ts` holds the list and acts on it by id (pause, resume, cancel, retry,
remove, open, show in folder, delete), `download-model.ts` decides what a file may be called and where it goes when
its name is taken, `dangerous-file.ts` names the types that run code, `download-store.ts` keeps the list in
`<userData>/downloads.json` (or in memory, for a private session), `install-downloads.ts` puts the service on every
session a tab can use, `folder-runner.ts` and `create-download-service.ts` are the parts that touch the machine
(the folder, the file manager, the trash), `downloads-domain.ts` is what the Downloads and Settings pages may ask,
and `change-throttle.ts` spaces the pushes that tell a page of progress. The toolbar side is `danger-hold.ts` (which
files are held and what a restart makes of the list), `download-attention.ts` and `window-attention.ts` (the dot on
the button, one tracker per window), `bubble-rows.ts` and `downloads-overlay.ts` (the bubble and its peek),
`peek-controller.ts` and `auto-open.ts` (when the peek opens and closes by itself).

**What it depends on.** [`../overlays/`](../overlays/) (`overlay-types.ts`, and `overlays.ts` to tell whether a popup is open); `electron` (`install-downloads.ts`, `folder-runner.ts`, and the `DownloadItem` and
`WebContents` types); [`../settings/`](../settings/) (the folder and the ask-where choice);
[`../storage/`](../storage/) (the debounced write); [`../shell/file-dialogs.ts`](../shell/file-dialogs.ts) (the
folder picker); [`../pages/internal-ipc.ts`](../pages/internal-ipc.ts) (the shape of a page's domain);
[`../shell/window-registry.ts`](../shell/window-registry.ts) (to tell a tab from any other page).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts): tabs are found through the window registry.
[`../../renderer/`](../../renderer/) code.

**Owner stream.** `shell`.

**Electron dependence.** The model, the store, the service and the domain do not depend on Electron and would
outlive a change of the engine beneath it. Setting the path in the `will-download` handler
(`install-downloads.ts`) and the machine operations (`folder-runner.ts`) are tied to it.

## Design notes

**The path is chosen inside the `will-download` handler, synchronously.** An item whose path is set later, or
never, stays in progress for ever and writes no file, so the service names the file before `track` returns:
the folder, the sanitised name, and `file (1).ext` when the name is taken on disk or by a download still running.
With "ask where to save" on, the handler instead hands Electron its own dialog options and lists the download once
the person has answered; an item that ends cancelled with no path was a dismissed dialog and leaves no trace.

**A page never names a path.** Every request from a page carries an id, and the path is read from the list kept
here. A name a server suggests goes through `safeFileName` (no directory part, no separators, no control or
bidirectional-override characters, no reserved Windows names, 200 bytes at most) and is joined to a folder the
service chose. Only the Settings page may choose the folder.

**A dangerous type is never opened from Orivon.** A completed file whose last extension runs code, or whose content
type is an executable one, is listed with "Open it from the folder": the operating system's file manager is the
place to decide.

**A page cannot flood the list.** A tab may run ten downloads at once, and a download the page started without a
click or key press counts against three in any ten seconds; a refused one is cancelled and recorded once as
"Too many downloads from this site". A download the person asked for (a retry, a click) is exempt. An address is
stored whole only up to 2,048 characters, and a `data:` address as its scheme alone.

**Which sessions.** The default session is handled at start; any other session the first time a tab is created in
it, so an app's own partition is covered without this code ever asking for a session by name. The embed, child and
web-context sessions hold no tab and keep their own refusal of downloads. A temporary `will-download` listener that
sets its own path (Save page as) runs after this one and wins, so the service reads the path back from the item.

**Why a download ended.** Chromium reports only that an item was interrupted. The service says "Disk full or no
permission" when the folder cannot be written, "The server stopped the download" when nothing arrived, and
"Network error" otherwise; entries left running by a previous run are "Orivon closed before it finished".

**A file that runs code is held, not just flagged.** When the save path is chosen without a dialog and the name or
the content type is one that runs code, the file is written as `Unconfirmed <id>.download` in the downloads folder,
so it never sits there under its real name before the person has said so. The entry keeps the real name and waits
as `held`; Keep renames the file to that name (numbered when taken) and Discard deletes it. A held entry survives a
restart while its file is there, and a download that does not arrive whole removes its temporary file. With a save
dialog the person has just named the file, so nothing is held and only the flag and the no-Open rule apply.

**The peek never takes focus and never crowds.** A new download opens the bubble as a peek only when the setting is
on, the button is not turned off, no other popup is open and the window has not had a peek in the last two seconds.
The chrome opens it, since only the chrome knows where its button is. It closes five seconds after nothing is running
and nothing is held, unless the pointer is on it. Its overlay does not close on blur: a click inside it hands focus
straight back to the page, and that blur must not close it.

**The dot is per window.** Each window's tracker starts level with the list and counts what finishes or breaks after
that until the bubble or the Downloads page is looked at; a file waiting for an answer outranks both.
