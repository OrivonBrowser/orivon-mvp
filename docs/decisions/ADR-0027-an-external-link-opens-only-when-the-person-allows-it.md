# ADR-0027: An external link opens only when the person allows it, each time

- **Status:** accepted
- **Date:** 2026-09-22
- **Type:** security
- **Decided by:** owner

## Decision

When a page opens a link whose scheme another app on the computer handles (`mailto:`,
`magnet:`, `bitcoin:`, `ethereum:` and the like), the shell asks the person every time, in a
dialog attached to the window showing the page: "Open *scheme* link with your system's default
app?", naming the requesting origin and the URL. Allow opens it; Cancel, Enter and Escape do not.
Nothing is remembered. The permission is `openExternal`, decided in
`src/main/sessions/external-links.ts` and asked by `src/main/shell/external-link-prompt.ts`; the
session's check handler always refuses it. It is not an `orivon.*` capability.

## Context

The deny-all gate refused `openExternal`, so a mail link, a magnet link or a wallet's payment
link did nothing on any page.

Measured in Electron 44: the request reaches only the session's request handler, as
`openExternal` with the target in `details.externalURL`, and it arrives whether or not the page
was clicked. Once the handler grants it, Electron itself hands the URL to the OS's handler for the
scheme (`xdg-open` on Linux); the gate never calls `shell.openExternal`, so nothing launches but
the URL the person was shown. `test/e2e-site-permissions.test.ts` asserts that Cancel launches
nothing and that Allow hands the OS handler exactly the URL the dialog displayed.

## Alternatives considered

**Allow without asking.** This is how a page turned Windows' `ms-msdt:` handler into code
execution with one click: an OS handler is code outside the browser's sandbox, reached with
arguments the page chose.

**Ask once and remember the answer per site.** A remembered yes lets a site launch the same
handler later with different arguments, unseen. The URL is the part the person has to see.

**Call `shell.openExternal` from the shell.** Electron already launches the URL once the request
is granted; a second launch path would be a second implementation of the same act.

**Name the target app in the dialog.** Finding the default app for a scheme on Linux means
running a subprocess synchronously, in the main process, for every question.

## Reasoning

`openExternal` passes on ground 2 of the gate's rule (`docs/open-questions.md` A202): a real
prompt the person answers, naming the site, with the check handler never allowing on the
person's behalf. The platform does not gate this power on a click, so ground 1 cannot hold.

What the dialog shows is bounded so it cannot mislead: the URL is escaped to printable ASCII, so
a line break or a bidi override cannot rewrite the lines around it, and cut at 200 characters.
Some schemes are never offered at all, whatever the person would answer: the browser's own
(`http(s)`, `ws(s)`, `file`, `data`, `blob`, `filesystem`, `javascript`, `about`, `chrome*`,
`devtools`, `view-source`), any scheme starting `orivon`, Chrome's list of OS handlers a page must
never launch, and `ms-msdt` and `search-ms`.

A page could otherwise loop the question. So one question per tab is ever open, a tab not on
screen is never asked for, and after asking the shell waits for a click or a key press in the
page before that tab may ask again, which is Chrome's own rule.

## Consequences

- Mail, torrent and payment links work on every page, one confirmation each.
- A cross-origin navigation that moves a tab into a new session (`ADR-0018`) builds a new view,
  and the new view starts with one question available, so a page that navigates across that
  line earns one more question without a click.
- `web-context-host.ts`'s deny-everything handlers keep external links away from `ADR-0019`
  isolated contexts.
- The dialog is asynchronous: every other tab keeps working while it is open.

## Reversibility

- **Cost to reverse:** cheap. The name goes back to denied; nothing is persisted.
- **What would make us revisit:** a scheme the never-offered list should carry, or a report of a
  page getting a person to allow a launch they did not intend.
