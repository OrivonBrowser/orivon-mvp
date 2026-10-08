# ADR-0050: Saved passwords stay in a local file, each encrypted by the OS keyring, and only the person's own choice fills a form

- **Status:** proposed
- **Date:** 2026-10-01
- **Type:** security
- **Decided by:** AI recommendation accepted by default

## Decision

Orivon keeps the logins a person saves for websites in `passwords.json` in the profile directory. Each
entry holds the site's origin and the username in the clear and the password encrypted on its own
through `safeStorage`, which is the operating system's keyring. Four rules bound it:

- **The store refuses instead of falling back.** Without a real keyring behind `safeStorage` (the
  `basic_text` and `unknown` backends, the same rule as the identity seed), in a private runtime, and
  with a file this build cannot read, the store is not ready and writes nothing. A file with some
  invalid entries is used without them, and the file they came from is kept beside it as
  `passwords.json.invalid` before the first write. A corrupt file is never overwritten. The file is
  written atomically and readable by its owner only.
- **No page-visible API.** The page's main world gets nothing: no credential API, no event, no value.
  A form watcher in the preload of every ordinary tab reports to main what the person typed and which
  boxes exist, only for a tab's top frame, only for `http(s)` pages, and only once main has switched it
  on. A fill starts only from a request of Orivon's own chooser after the person picks an account, and
  main re-checks that the tab's top frame is still at the login's origin when it sends the fill.
  Nothing fills a form by itself.
- **The person's gesture is required.** The chooser under a focused box opens only after a real user
  touch of the page and after a trusted focus event, and ignores a click in the first 500 ms. Revealing
  a password is a two-step click, since Electron has no cross-platform re-authentication to ask for;
  copying happens in main, and the clipboard is cleared 60 seconds later if it still holds that password.
- **CSV in and out, nothing else.** Import reads a CSV file the person picks (both common header
  shapes, 5,000 rows and 5 MB at most, `http(s)` origins only). Export asks for a second click, then a
  native save dialog, and writes a plain-text file readable by its owner alone; a cell that starts with
  `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading quote that import removes. The
  store holds at most 2,000 logins. There is no sync, no breach check and no import from another
  browser's own store.

## Context

The browser had no password store; a person who lives in it every day needs one, and the
success metric counts people who arrive from other browsers. A password store is the most valuable
thing a browser keeps after the identity seed, and the form watcher puts new code in every ordinary
tab, where a hostile page is the adversary.

## Alternatives considered

**One file encrypted with one key.** The key would sit beside the file, or one keyring item would be
read on every list; the first protects nothing and the second costs an unlock for every draw.

**A plaintext fallback with no keyring.** Rejected: a password under a key that sits beside the file
protects nothing, and a person would not know.

**A native password-store module.** Rejected by CLAUDE.md Rule 8: Orivon's own dependencies take none.

**Read another browser's stored passwords.** Rejected for the same reason: they are encrypted with
the operating system's keystore, which needs native code to open.

**A page-visible credential API (`navigator.credentials` with a password), or a fill on page load.**
Rejected: it lets a hostile page, or a hidden form, ask for or harvest a saved password with no person
in the loop.

**Re-authenticate with the operating system before a reveal.** Not available across platforms in
Electron 44.

## Reasoning

The identity seed already rests on `safeStorage` and refuses without a real keyring; the same rule here
keeps one definition of what "protected" means. One encryption per entry lets the list be drawn without
a keyring round trip and a single failed entry be dropped without losing the rest. Because the page
sees nothing, the attack a page can mount is limited to what a person can be talked into choosing, and
the chooser shows the site the login belongs to.

## Consequences

- On a Linux machine with no keyring there is no password saving at all, and Settings says why.
- Usernames and origins are readable on disk by any process of the same user. `safeStorage` does not
  defend against a same-user local process (security model T24), and the exported CSV file is plaintext.
- An extension's content script, or script injected into the real site, can read a filled field exactly
  as it reads a typed one. Orivon does not defend against that, and says so
  (`docs/architecture/security-model.md`).
- Forms in frames, in shadow DOM, and sign-ins started by a script alone are not seen. Electron 44's
  clipboard cannot mark a copied password confidential, so a clipboard history may keep it
  (`docs/open-questions.md` A327).

## Reversibility

- **Cost to reverse:** moderate. The file carries a version; changing the store means migrating it, and
  a person's exported CSV is the way out.
- **What would make us revisit:** a cross-platform way to ask the operating system to confirm a reveal,
  a keyring-backed store that works without per-entry encryption, or a report of a fill reaching a page.
