# ADR-0060: A file opened from this computer is an origin of its exact path

- **Status:** accepted
- **Date:** 2026-10-06
- **Type:** security
- **Decided by:** owner (persistence like a website, keyed to the exact path; the packages claim HTML, XHTML,
  SVG and PDF; the defaults of the open questions); AI recommendation, accepted by default, for the sessions,
  the fence and the handler.

## Decision

A document opened from this computer is an origin of its own, keyed on its `file:` URL with an empty host and
no query or fragment (`localFileKey`, at most 2,048 characters). Its grants, saved data, `id` keys and
`secrets` persist across restarts like a website's, keyed to that path. A moved or renamed file is asked
again, and another file saved at the same path gets what the path held.

- **Key.** `isolationKeyFromUrl` is the web origin or the local-file key. `callerKeyFromSenderFrame` accepts
  a file frame only while Chromium reports its origin as `file://` (a sandboxed document is opaque and is
  refused as a sandboxed web frame is). `originFromUrl` still answers null for `file:`, so a caller not yet
  moved to the key fails closed. `isPersistableOrigin` accepts a local-file key: every ledger write, the fs
  root `app-data/<hash>` and the `id` and `secrets` derivation use the same rules as a website's, with no salt.
- **Two kinds of session, both persistent.** A local file runs in `persist:orivon-local-files` until the person
  lets it use Orivon permissions. A file recorded for that (`local-file-apps.json`, one key per file) runs in
  `persist:local-<sha256 of its key>`. The record picks the session and never stands for a grant: grants come
  live only from a fresh manifest read at the document, as for a website (A137). ADR-0044 kept every granted
  website in the default session because extensions span it; no extension loads in a local session, so its
  reason is absent here. Cookies stay inside the local sessions.
- **Handler.** Every local session serves `file:` through `protocol.handle('file')` over Chromium's own
  loader, with `X-Content-Type-Options: nosniff` on every response and no other policy; a document whose key
  holds grants also gets the policy a granted website gets, with inline scripts allowed (its refusal exists
  for DOM an extension writes, and no extension runs here). It refuses a host, a `//` path, a Windows path
  that names no drive, any method but GET and HEAD, and every request while the binary's file-protocol fuse is
  not off.
- **Fence.** A `webRequest` listener in each local session cancels every `file:` main-frame, frame and
  `<object>` or `<embed>` load that belongs to another local session. A cancelled main frame fails with -20,
  and the tab then moves to the session the file belongs in; a 404 from a session that is not local does the
  same through `did-navigate`. One function (`localPartitionFor`) names a file's session for the tab, the
  fence and the attribution, so the two cannot disagree and a tab cannot loop.
- **Every other session answers `file:` with a 404** at creation, so Back into a file entry reads nothing
  there and the tab is moved.
- **Attribution.** A file key is attributed only while the tab's session is the one `localPartitionFor`
  names now. A document's path is fixed for its life, so nothing else can differ.
- **Planted files.** A download or a saved page is never named after a recorded file's path: the name is
  numbered. Another writer on the machine (a browser, an archive extractor) can still put a different file at a
  recorded path, which then inherits its grants; the consent says so.
- **Manifest, local.** `entry` and `domain` are ignored; `crossOriginIsolated` is not honoured in this build;
  the version floor is not read, as for a website granted without installing.
- **Network.** A local page sends `Origin: null`, no cookie of the web's, and reaches loopback and the LAN as
  any web page does.
- **Consent.** A file that links a manifest is asked about once, in the warning style, with a button that
  answers only on a second press within 1,500 ms of the first, armed after the question's guard and an arrival
  of the pointer or the focus on it. The manifest is read only from under the document's folder, through real
  paths that stay inside it and no larger than a manifest may be. A Yes records the file (which is what moves
  it to its own session) and grants all it declares; a held capability that the manifest now widens asks again
  and a Yes replaces it; a path nobody recorded has any persisted grant, pick and refusal dropped before it is
  asked. A limit no pattern shows (quota, curves, sockets) of a changed manifest applies without a question
  (A404). Site info names the file by path, shows no Web3 Score and offers Turn off (the record stays) and
  Delete data (grants, session, saved files, record); the privacy page lists the recorded files.
- **Opening.** A file opens only by the person's choice or from the browser's own stores: a typed path or
  `file:` address (in a new tab), a bookmark, history, a restored tab, Open file, the operands of a second
  start and the system's open-file event. A page's link, `window.open`, redirect or an extension cannot open
  one, and a file dropped on a web page opens as a local file while the page's own navigation to one is
  stopped (A399). The binary's fuse is read on the first open of a local file in a run, not at start-up.
- **Scripts.** On a document that is itself a local file, a script it loaded from `file:` counts as the page's
  own for `window.orivon` (T52's call-stack rule); on a web document a `file:` frame still counts for nothing.
- **Claims.** The packages claim HTML, XHTML, SVG and PDF as documents Orivon can open, and as the default
  browser Linux also takes `text/html`, `application/xhtml+xml` and `application/pdf`. Neither system's
  extension is taken over. macOS and Windows are provisional (A397). A folder opens as a listing Orivon writes.

## Context

`d-0502` decided that local files open, that a local page may use `window.orivon` behind a consent that needs
a double press, and that grants and data persist per exact path. ADR-0059 turned the file-protocol fuse off,
which removes the extra privileges Electron gives a `file:` page. Probes on that binary (Electron 44) found
that no channel reads another file's bytes or pixels, with or without a handler: `fetch`, XHR, module and JSON
imports, frames, objects, workers and CSS are refused; an image taints a canvas; `history.pushState` cannot
leave the document's path; XSLT `document()` of a sibling returns an empty string. They also found what a
policy cannot cover. A text file that parses as JavaScript runs as a classic script and leaks its first
unknown word unless the response carries `nosniff`. IndexedDB, Cache Storage, OPFS and `BroadcastChannel` are
one store for every `file:` document in a session. `localStorage` throws (A396). `'self'` in a policy matches
every `file:` URL. A handler's request carries no destination, so only `webRequest` tells a document from a
subresource; a `webRequest` cancel stops `mainFrame`, `subFrame` and `object` loads.

## Alternatives considered

- **Grants and data last until quit** (a per-run key salt, a folder emptied at start and at quit). Rejected by
  the owner: persistence like a website's loses nothing a person saved, and moving to it later from a
  run-scoped design would have deleted data.
- **One persistent session for every file.** Rejected: IndexedDB, Cache Storage and OPFS are then shared by
  every local file, so a granted file's data would be readable by any other file.
- **A session for every file from its first open.** Rejected for now: a session and a folder for each file ever
  opened. The cost is that a page's earlier storage stays behind at a Yes, and the consent says so (A398).
- **A base policy in the handler** (`connect-src`, `frame-src` without `file:`). Rejected: the probes show the
  platform already refuses every read it would stop, and a policy on a document that cannot name its folder
  (`file:///dir/` is not a valid source) only breaks pages.
- **A grant that follows the file's content.** Rejected: a local file has no signed manifest or Web3 Score, so
  nothing could say two contents are the same app.

## Reasoning

The platform closes every read once the fuse is off; what remains is storage shared inside a session, and
sessions are what the browser can partition. A record that picks the session keeps a granted file's data apart
from every other file's without a session per file ever opened. `nosniff` costs only a file with no type, and
the fence answers the one load type a handler cannot see.

## Consequences

- A person's grants for a local file outlive a restart, so what is at that path matters: whoever can change
  the file can change what it does and use what was allowed. The consent says it and says a different file
  saved there later gets the same permissions.
- T13c now excludes the exact local path from "never persist": the key is not a place another server can
  occupy.
- A file's earlier storage is not carried into its own session (A398); `localStorage` is unavailable (A396).
- A load type the fence misses would reach another session's file as a document; the probes name the three
  that can.

## Reversibility

- **Cost to reverse:** expensive for persistence (grants and data on disk are keyed to paths); moderate for
  the sessions and the fence, which are one module and one hook.
- **What would make us revisit:** a read of another file found on a new Electron version; a measured way to
  scope web storage per file without a session; a person losing a saved page to a moved file in a way the
  consent does not explain.
