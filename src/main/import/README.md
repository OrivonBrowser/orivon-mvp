# `src/main/import/`: bookmarks and history from another browser

**What lives here.** Reading the files of other browsers on this computer, once and on request, and bringing
their bookmarks and history into Orivon's own stores. `browser-roots.ts` says where each browser keeps its
profiles on each operating system, `browser-profiles.ts` finds the profiles that can be read,
`chromium-bookmarks.ts`, `chromium-history.ts`, `firefox-places.ts` and `bookmarks-html-import.ts` turn a
source's files into trees and rows (the first and last are pure), `sqlite-copy.ts` opens a database safely,
`bookmark-merge.ts` decides where bookmarks go and leaves out what is already there, `import-runner.ts` runs one
import, `import-domain.ts` is what the Import page may ask, `import-host.ts` is its view of this machine, and
`import-test-seam.ts` points the detector at a fake home in test builds.

**Tied to Electron, in one file.** `import-host.ts` imports `electron` (the home directory, the file dialog).
Everything else runs under plain Node and would outlive a change of the engine.

**What it depends on.** `node:sqlite` (Node's own: Rule 8), `node:fs/promises`;
[`../browsing/`](../browsing/) (the bookmark tree's types and the address check);
[`../history/`](../history/) (the import filter and the row shape); [`../pages/internal-ipc.ts`](../pages/internal-ipc.ts)
(the shape of a page's domain); [`../shell/file-dialogs.ts`](../shell/file-dialogs.ts).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts), and any renderer code. Nothing in this
directory may write to another browser's files, or read a file other than the six it names.

**Owner stream.** `shell`.

## Design notes

**Other browsers' files are untrusted input, and only six of them are read.** `Local State`, `Bookmarks` and
`History` for the Chromium family; `profiles.ini` and `places.sqlite` for Firefox; and a bookmarks HTML file the
person picks. Cookies, logins and everything else in those directories are never opened. A profile directory comes
from a file the other browser wrote, so it is used only when it resolves, links followed, inside that browser's own
root: a crafted `Local State` or `profiles.ini` cannot point the reader elsewhere.

**A database is read from a copy, never in place.** `sqlite-copy.ts` copies the file and its write-ahead log into a
private temporary directory and opens the copy read-only, so a running browser is never written to, locked or
left with a stray file, and the rows it has not yet folded into the file are still seen. The directory is deleted
afterwards. A file that cannot be copied because something holds it is `locked`.

**Passwords are not imported.** Their stores are encrypted with the operating system's keystore, which needs
native code to open; Orivon's own dependencies take none (Rule 8).

**Nothing in a foreign file sets a limit.** Every reader stops at 20,000 nodes, folders nested past the depth the
store allows are flattened into the deepest one (and never walked recursively), titles are cut to 512 characters,
and every address goes through the stores' own checks on the way in: a `javascript:` bookmark is counted as skipped,
never kept. History is filtered by the recorder's own address rule, the retention window and the present, and is
capped at 20,000 pages and at the room left under the history's own cap.

**An import twice adds nothing twice.** Bookmarks already where they would go are counted as already there, and a
history visit already recorded at the same time is taken to be the same visit. Bookmarks go into the bar and Other
bookmarks as they were when the person has none yet, and otherwise into one folder on the bar named for the browser.

**A private window reads nothing.** `import-domain.ts` answers every request with `{ private: true }` before it
looks at the request, and the page shows one message.
