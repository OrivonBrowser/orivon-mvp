# ADR-0028: A site shows notifications only after the person allows it, remembered per site

- **Status:** accepted
- **Date:** 2026-09-22
- **Type:** security
- **Decided by:** owner

## Decision

The first time a site calls `Notification.requestPermission()`, the shell asks the person, in a
dialog attached to the window showing the page: "*site* wants to show notifications", with Allow,
Block and Not now. Allow and Block are remembered per origin in
`<userData>/notification-decisions.json`, one store shared by every session, so a site decided
in one partition is decided in all. Not now, Enter, Escape or closing the dialog stores nothing,
and that page load is not asked again. The session's check handler, which answers
`Notification.permission`, the Permissions API and every notification the page tries to show,
answers from the stored decision alone. A frame never asks; only a frame of the page's own site
gets the page's stored answer. The permission is `notifications`, decided in
`src/main/sessions/site-notifications.ts` and `notification-decisions.ts` and asked by
`src/main/shell/notification-prompt.ts`. It is not an `orivon.*` capability.

## Context

The deny-all gate refused `notifications`, so no page could show one: chat and mail clients, a
dapp's transaction alerts, a torrent app's "download finished".

Electron splits the permission across its two handlers. `requestPermission()` reaches the
asynchronous request handler, which can ask. Everything else reaches the synchronous check
handler, which cannot ask and can only return yes or no.

## Alternatives considered

**Keep it denied.** Every page that notifies breaks, and nothing about notifications needs a
blanket refusal: the person can be asked.

**Allow without asking.** Any site could put text on the desktop that looks like it came from
the system, the abuse every browser answers with a per-site question.

**An `orivon.*` capability with a manifest field.** An ordinary website has no manifest, so it
would stay broken, and a notification is a web-platform power an app does not need a grant for.

**Ask every time.** A site that notifies is a site the person wants to hear from repeatedly;
asking on every load teaches them to click through.

**Require a click before asking.** Chrome does not for notifications, and a page that asks at
load, as most do, would never get its question shown.

## Reasoning

`notifications` passes on ground 2 of the gate's rule (`docs/open-questions.md` A202): a real
prompt the person answers, naming the site, with the check handler never allowing on the
person's behalf. Remembering both answers per site is what every browser does and what makes
Block mean something; not remembering Not now keeps a dismissal from becoming a silent decision.

## Consequences

- A site asks once and, if allowed, can show notifications from then on, across restarts.
- Electron's check handler is a boolean, so `Notification.permission` reads `'denied'` for a site
  nobody has decided yet, not `'default'`. A page that calls `requestPermission()` still gets
  asked; a page that reads `permission` first and gives up on `'denied'` never asks.
  *Provisional:* this is Electron's documented behaviour, awaiting a measurement against a real
  page (`docs/open-questions.md` A242).
- A decided site can be reset to undecided (`NotificationDecisions.forget`), but the permissions
  panel does not offer that yet.
- `web-context-host.ts`'s deny-everything handlers keep notifications away from `ADR-0019`
  isolated contexts.

## Reversibility

- **Cost to reverse:** cheap. The name goes back to denied, and the decisions file is ignored.
  Nothing else persists.
- **What would make us revisit:** Electron giving the check handler a way to answer "not
  decided"; or a report of a site misusing an allowed permission, which would make a per-site
  revoke in the panel urgent.
