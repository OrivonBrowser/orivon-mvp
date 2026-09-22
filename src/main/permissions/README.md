# `src/main/permissions/`: the grant list a person can revoke from

**What lives here.** `permissions.ts`: the grant list, with revocation (d-0027, owner decision
9 — a grant lasts until revoked, and is visible in a list the user can revoke from). Revoke
only; there is no "forget this app entirely" here, that is `GrantLedger.forgetOrigin`.
`permissions-panel.ts`: queue item 4.4's in-window panel hanging off the toolbar's permission
key.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/),
[`../../broker/`](../../broker/) (`broker-contracts.ts`, `policy/origin.ts`,
`policy/request-grant.ts`, `grants/ledger-storage.ts` types), [`../../loader/manifest.ts`](../../loader/manifest.ts),
[`../consent/grant-prompt-render.ts`](../consent/grant-prompt-render.ts), and, inside `src/main/`,
`../shell/renderer-entry.ts`, `../ipc/settings-ipc.ts`, the top-level `channels.ts`/`registry.ts`.

**What it must never import.** Nothing bypasses `PermissionsController`. Both renderer surfaces
that show grants — `src/renderer/settings/permissions-view.ts` (the settings panel) and the
toolbar's address-bar icon — reach the broker only through `permissions.ts`, never directly;
neither is a `broker` import away from the trust boundary this file already crossed once.

**Owner stream.** `shell`, queue item 4.4. Maintenance only.
