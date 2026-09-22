# ADR-0024: The permission gate allows a file the person chose, never a directory

- **Status:** proposed
- **Date:** 2026-09-22
- **Type:** security
- **Decided by:** AI recommendation accepted by default

## Decision

`src/main/sessions/permission-gate.ts` allows the Chromium permission `fileSystem` when the
request names a single file (`isDirectory: false`), for reading and for writing, on every session
the gate covers. A directory is refused in both modes, and so is any request whose details do not
say it names one file. Like clipboard write (`ADR-0022`), this is not an `orivon.*` capability:
nothing is declared in a manifest, no grant is issued, and nothing appears in the permissions
panel. What bounds it is that a page can only hold a handle to a file on disk that the person
chose.

## Context

FreeTube's import and export failed with `NotAllowedError` from `createWritable()`. Its Electron
renderer, which the port runs unmodified, reads through `showOpenFilePicker()` and writes through
`showSaveFilePicker()`: the File System Access API. The gate denied `fileSystem` outright, and
because it covers `session.defaultSession`, every ordinary website that opens or saves a file this
way failed the same way.

Measured against Electron 44 with a real page, a headless probe logging both handlers while files
were handed to the page by drag and drop: every File System Access operation (`getFile()`,
`createWritable()`, `queryPermission()`, `requestPermission()`, listing a directory) is decided by
the session's synchronous permission **check** handler, with `filePath`, `isDirectory` and
`fileAccessType` in its details. The request handler was never called, not even for
`requestPermission()` after a real click. Electron therefore offers no asynchronous point at which
a prompt could be shown. Whatever the check handler returns is the answer.

`docs/open-questions.md` A202 asked for a stated rule before a second permission joined the
allowlist. Its recommendation has two clauses: (1) the web platform gates the power on an action
by the person that the shell can neither fake nor suppress, and (2) a legacy path grants the same
power anyway, so denying it costs real pages without closing anything.

## Alternatives considered

**Allow `fileSystem` without condition**, which is Electron's own default when no handler is
installed. It lost on directories. A directory handle reaches every file beneath it, including
files created later, and Chrome asks a separate, explicit question before granting one. With a
synchronous handler and no prompt, allowing it would hand a page a whole tree on the strength of
a picker the person may have opened to choose one file.

**Allow reading, refuse writing.** This fixes import and leaves export broken. It protects
little: the file being written is the one the person just chose in a save dialog, and a download
can already write a file wherever the person saves it.

**A prompt of Orivon's own before a write.** The check handler is synchronous, so a prompt could
only run after the page's call had already failed, and the page would have to retry. No web page
does. Prompting before the fact would mean intercepting the pickers themselves, and Electron
exposes no hook for that.

**An `orivon.*` capability with a manifest field.** This has ADR-0022's problem: an ordinary
website has no manifest, so it stays broken. The person's choice of file is already the consent,
which is the principle `orivon.fs.userSelected` rests on (`ADR-0002`: "the user choosing the path
*is* the consent. (Same principle as the web File System Access API.)").

## Reasoning

A page cannot name a path. A handle to a file on disk exists only because the person picked it in
an OS dialog (`showOpenFilePicker()` and `showSaveFilePicker()` both require transient user
activation), dropped it onto the page, or pasted it. That satisfies A202's first clause. The
second clause holds for the two operations real pages use: `<input type="file">` already hands a
page the contents of a file the person picks, and a download already writes a file where the
person saves it.

Refusing directories keeps each handle bounded to one choice. A file inside a directory can be
reached only through the directory's own read grant, which the gate refuses, so a page can reach
no file the person did not hand over individually. `test/e2e-file-system-access.test.ts` asserts
this against a real page and a real file on disk.

## Consequences

- FreeTube's import and export work, as does any website that opens or saves a single file
  through File System Access.
- **Folder access stays refused**, both `showDirectoryPicker()` and a dropped folder. A site built
  around opening a folder, such as a web IDE, cannot use one here.
- **Two powers go beyond Chrome's, because this gate cannot prompt.** Both are stated here, and
  both are bounded to files the person handed over at some point:
  - A page can write back to a file the person opened or dropped for reading. Chrome first asks
    whether to save changes to that file.
  - A handle the page stored in IndexedDB keeps read and write access in a later session. Chrome
    asks again on the next visit.
  `docs/open-questions.md` A205 tracks whether either should get a prompt.
- `web-context-host.ts`'s deny-everything handlers keep File System Access away from `ADR-0019`
  isolated contexts, as they do clipboard write. They remain load-bearing.
- The argument rests on two upstream behaviours this project does not control: that the check
  handler alone decides, and that `isDirectory` is reported truthfully. The e2e test asserts both
  through their effects: a file is read and written, and a directory is refused.

## Reversibility

- **Cost to reverse:** cheap. One predicate and its tests. The gate persists nothing: no
  manifest field, no grant, no migration.
- **What would make us revisit:** Electron routing File System Access through the request
  handler, which would make a real prompt possible; Chromium's pickers no longer requiring user
  activation; or a concrete abuse of either power listed under Consequences.
