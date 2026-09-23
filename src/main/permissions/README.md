# `src/main/permissions/`: the grant list a person can revoke from

**What lives here.** `permissions.ts`: the grant list, with revocation (d-0027, owner decision
9 — a grant lasts until revoked, and is visible in a list the user can revoke from). Revoke
only; there is no "forget this app entirely" here, that is `GrantLedger.forgetOrigin`. A revoke
also records the capability as declined (`Broker.recordDeclinedConsent`), so the install-consent
dialog does not ask for it again at the next launch; `app.requestGrant` still can, and an
accepted request clears that record.
`permissions-panel.ts`: queue item 4.4's in-window panel hanging off the toolbar's permission
key. `permissions.ts` also turns each site's remembered notification answer into a row a person
can reset (`createSiteNotificationsController`): a Chromium permission, not an `orivon.*` grant,
so the panel shows it as its own card per site, after the apps, and Reset means the site asks
again.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/),
[`../../broker/`](../../broker/) (`broker-contracts.ts`, `policy/origin.ts`,
`policy/request-grant.ts`, `grants/ledger-storage.ts` types), [`../../loader/manifest.ts`](../../loader/manifest.ts),
[`../consent/grant-prompt-render.ts`](../consent/grant-prompt-render.ts),
[`../sessions/notification-decisions.ts`](../sessions/notification-decisions.ts) (type only), and, inside `src/main/`,
`../shell/renderer-entry.ts`, `../ipc/settings-ipc.ts`, the top-level `channels.ts`/`registry.ts`.

**What it must never import.** Nothing bypasses `PermissionsController`. Both renderer surfaces
that show grants — `src/renderer/settings/permissions-view.ts` (the settings panel) and the
toolbar's address-bar icon — reach the broker only through `permissions.ts`, never directly;
neither is a `broker` import away from the trust boundary this file already crossed once.

**Owner stream.** `shell`, queue item 4.4. Maintenance only.
