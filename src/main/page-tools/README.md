# `src/main/page-tools/`: what a person does with the page in front of them

**What lives here.** The `page.*` commands: print, Save as PDF, Save page as, View page source,
Take a screenshot and Picture in picture, the two overlays they use (the screenshot sheet and the
toast that reports what happened), and the names they give files. `page-commands.ts` is the one
function per command that `../shortcuts/run-command.ts` calls; each command is a module of its own
(`print.ts`, `save-pdf.ts`, `save-page.ts`, `view-source.ts`, `screenshot.ts` with `screenshot-run.ts`,
`pip.ts`).

**Tied to Electron, entirely.** Every page tool drives a `WebContents` (print, `savePage`, the
debugger, a frame's `executeJavaScript`). The decisions that do not (`file-names.ts`, `toast.ts`'s
table, `fullPageClip`, the frame order in `pip.ts`) import nothing from `electron`, and the modules
that do type the contents they take as a small interface, so every tool is tested against a fake.
`real-deps.ts` is the one file that touches the file system, the clipboard and the save dialog.

**What it depends on.** `../overlays/` (types), `../shell/` (`file-dialogs.ts`, the window and tab
types), `../shortcuts/commands.ts` (the id a toast link runs), `../browsing/omnibox.ts` (the address
gate for `view-source:`).

**What it must never import.** `../shell/tabs.ts` for its class (only its type), a renderer, or
anything that lets a page name a path: a file path comes from the save dialog and from nowhere else.

**Owner stream.** `shell`.

## Design notes

**Print refuses before it calls.** With no printer, `webContents.print` never calls back and leaves
the tab's page unresponsive for good, so `print.ts` lists the printers first and shows a toast that
offers Save as PDF instead. A cancelled dialog is not a failure and says nothing.

**Every wait on a page has a clock.** A crashed or wedged page never settles an `executeJavaScript`,
`capturePage` or `printToPDF`, and the clipboard may never answer on a machine with no display
server, so `with-timeout.ts` bounds each and a timeout reads as the tool's failure toast.

**The full page is taken by the debugger, for one command.** `Page.captureScreenshot` with
`captureBeyondViewport` renders the page without resizing the window. The debugger is attached for
that command and detached in every outcome, it is not attached at all while developer tools hold it
(the sheet disables the choice and says why), and a picture more than 16,384 device pixels on a side,
or 64 million in all, is cut there, because a larger image cannot be encoded. The pixel density is the
page's zoom on the window's screen scale, both read in main: a page can redefine `devicePixelRatio`,
so it is never asked.

**The sheet closes before the picture.** The picture is of the page, which the overlay never covers,
but closing first returns focus to the page and keeps the sheet out of any later capture; the one
frame of wait is the compositor's.

**A file the tab shows is downloaded, not re-saved.** A page of another type (an image, a PDF, plain
text) saved as HTML would be a wrapper around nothing, so `save-page.ts` downloads the address through
the tab's session into the chosen path. It listens for that one download, recognised by the address
it was asked for in the item's chain (a download the page starts itself is left alone), and sets its
path synchronously, which a download needs: an item given a path later never completes. One that
makes no progress for a minute is cancelled.

**What is read from a page is read in an isolated world.** The content type (Save Page As) and
the selection (the find bar) come from `executeJavaScriptInIsolatedWorld`, where a page that
redefines `document.contentType` or `window.getSelection` in its own world changes nothing. A world
id belongs to one reader: 1002 here, 1003 for the find bar.

**`view-source:` skips an app's tab.** An app's tab may be served from the cache Orivon holds for it,
and a source view opens in the shared session, so it would fetch the address again from the network.
The address gate is the address bar's own (`sanitizeDirectUrl`), and the tab opens through
`openTrusted`, which the address bar's refusal of other schemes does not apply to.

**Picture in picture asks every frame to put a video back first.** A video already out in an embedded
frame must not be joined by a second one from the main frame, so the exit script runs across all
frames before the enter script runs in any. Both run with a user gesture, and both are constant
strings.

**The PDF viewer needs no setting.** A served PDF renders in an ordinary tab through Chromium's own
viewer; nothing here enables it, and there is no switch that makes a PDF download instead.

**A toast's link is the one thing a page of an overlay can trigger, and main chooses what it runs.** `showToast`
records the command of the toast it showed, and the overlay's request runs that command only, never one the page
names. A toast with a link stays eight seconds and pauses while the pointer is on it; a saving toast stays until the
save ends.

**A save that sets its own path must not be undone by a session-wide download handler.** Save page as on a tab that
shows a file sets the item's path from a one-shot `will-download` listener. A handler that answers every download
must leave alone an item whose save path is already set.
