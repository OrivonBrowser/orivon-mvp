# `src/main/auth/`: the sign-in sheets an HTTP server asks for and the certificates a connection shows

**What lives here.** What a tab can be asked, each answered in a sheet over that tab:

| Question | Files |
|---|---|
| A username and password (HTTP 401, or 407 from a proxy) | `login-handler.ts` (the `login` event), `auth-queue.ts` (pending challenges and the rules that limit them), `auth-text.ts` (what the sheet says), `auth-sheet-overlay.ts` (the `auth-sheet` overlay), `auth-state.ts` (the process's one queue, and saving a remembered password once it worked) |
| A client certificate | `client-certificate.ts` (the `select-client-certificate` event, which asks through `ask-chooser.ts`) |
| Which of a short list | `ask-chooser.ts` (`askChooser(window, tabId, spec)`), `chooser-store.ts`, `chooser-overlay.ts` (the `chooser` overlay); the device chooser reuses it |
| What certificate a page came over | `note-certificate.ts` (called from the session's one verify proc), `certificate-cache.ts`, `certificate-view.ts`, `certificate-overlay.ts` (the `certificate` overlay), `certificate-open.ts` (the `site.certificate` command and the site-info row) |

`install-auth.ts` is the installer `../shell/shell-installers.ts` runs at start. The pages are in
[`../../renderer/overlay/`](../../renderer/overlay/) (`auth-sheet/`, `chooser/`, `certificate/`).

**What it depends on.** `electron` (types, and `clipboard` in `certificate-real.ts`), [`../shell/`](../shell/)
(`ShellInstaller`, `ShellServices`, `ShellWindow`), [`../overlays/`](../overlays/) (`OverlayDef`, `requestSlot`),
[`../passwords/vault.ts`](../passwords/vault.ts), [`../../broker/policy/origin.ts`](../../broker/policy/origin.ts).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).

**Owner stream.** `shell`.

**Electron dependence.** The installer, `tab-load.ts`, `certificate-real.ts` and `auth-sheet-real.ts` are tied to
Electron; every other file imports no `electron` value and runs under plain Vitest.

## Design notes

**A challenge that is not from a tab keeps Electron's answer, which is no.** An extension's page, a guest, a shell
view and a main-process fetch reach `login` with a web contents that is not a tab (or none): the handler does not
prevent the default, so nothing can put a sheet in front of the person on their behalf.

**The sheet names the server from `authInfo`, never from the page.** A subresource or an iframe asking is flagged in
main by comparing its host and port with the tab's page, and a saved password is never offered to it. After a
cancel, the same server and realm is answered with a cancel for the rest of that page load, and a page load gets
three sheets at most, so a page cannot keep the person answering. A page load is the tab's main-frame navigation
count (`tab-load.ts`), so a reload asks again.

**A saved password never reaches the page.** The sheet is told the username of a saved login; when the person
submits that username with the password box empty, main reads the password from the vault. "Remember this password"
saves only once the page has stopped loading without the server asking again, because a wrong answer is asked
again before the page finishes.

**The certificate is read in the one verify proc.** Electron keeps one verify proc per session and
`verifier/verifier-subsystem.ts` already owns it; it calls `noteCertificate` before answering and never changes its
verdict. The cache holds public data for at most 200 hosts. The viewer answers only for the active tab's host, read
in main, and only for an `https:` page. Chromium does not call the proc again for a host whose verification it still
holds, so a host the cache dropped cannot be read again by reloading until Chromium verifies it afresh.

**A chooser answers with an id main offered.** The page returns the id of a row; the store refuses any other, and
every way the sheet can end but a choice answers the question with null.
