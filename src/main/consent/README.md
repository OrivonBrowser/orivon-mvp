# `src/main/consent/`: decide what to ask, say it, show it

**What lives here.** Every grant decision this browser makes, in three layers per feature:
`install-consent.ts`, `request-grant.ts` and `update-outcomes.ts` decide;
`grant-prompt-render.ts` (with `grant-prompt-connect.ts`, `grant-prompt-origin.ts` and
`grant-prompt-choice.ts`) turns a decision into words; the three `*-prompt.ts` files show those
words in a native dialog. `grant-level.ts` is the one place a Level 4 site's summary loses its
warning (`ADR-0037`). `grant-changed-capabilities.ts` is the one place accepted capabilities
become `broker.grant()` calls. `request-grant-subsystem.ts` wires `request-grant.ts` into the
running app.

**What it depends on.** [`../../contracts/`](../../contracts/),
[`../../broker/policy/`](../../broker/policy/) (`manifest-patterns.ts`, `request-grant.ts`,
`update.ts`, `canonical-host.ts`, `connect.ts`, `connect-patterns.ts`, `address.ts`),
[`../../broker/broker-contracts.ts`](../../broker/broker-contracts.ts) (type only),
[`../../loader/index.ts`](../../loader/index.ts) (type only),
[`../../trust/website-level.ts`](../../trust/website-level.ts) (`ScoreLevel` type only),
[`../../protocols/builtin.ts`](../../protocols/builtin.ts) (the displayed address of a protocol
origin), [`../dev/score-levels.ts`](../dev/score-levels.ts) (wired in at
`../install/app-install-subsystem.ts` and `./request-grant-subsystem.ts`), and the top-level
`registry.ts`.

**What it must never import.** `electron`, in every file except the three `*-prompt.ts`. The
suffix rule ([`../README.md`](../README.md)) is load-bearing here: every other file is
unit-tested under plain vitest with no real dialog, and an `electron` import in one of them would
silently lose that.

**Durable or tied to Electron.** The deciding and wording files hold no Electron type and would
survive an engine change; the three `*-prompt.ts` files are tied to Electron's `dialog`.

**Owner stream.** `shell`. Maintenance only.

## Design notes

**Every pattern is rendered from the parsed form, never a second guess at the raw string.**
Patterns go through `hostSpecKind` and `parsePattern`
([`../../broker/policy/connect-patterns.ts`](../../broker/policy/connect-patterns.ts)), the
grammar the runtime matcher uses. A second, weaker parser here would let the prompt and the
matcher disagree: `'*:443'` would render as a literal host called `*` while the matcher reaches
any public address, and a host declared on several ports would read like one on a single port.

**[`grant-prompt-origin.ts`](grant-prompt-origin.ts): the origin keeps the host's last three
labels, never a character count (A115, A142).** The label that decides authority sits at the far
right (`accounts.google.com.attacker.example`), where a narrow dialog is least likely to show it.

- **Three labels needs no public suffix list.** `example.co.uk` has three labels and shows whole;
  `www.example.co.uk` reduces to `example.co.uk`, never to the `co.uk` a "last two labels" guess
  would give. The count only has to know how many labels to keep, never which ones a registry
  controls, so every two-label public suffix (`.co.jp`, `.org.uk`) comes out right.
- **Length never elides anything**, and an IP literal is returned unchanged: cutting it would
  name a different machine, not shorten a prefix. The scheme is never touched; a non-default
  port is reattached after the cut, so it cannot change which labels survive.
- **A multi-label private hosting suffix keeps one more label (A161).** `s3.amazonaws.com` is
  itself three labels, so a plain cut would drop the bucket name and show what reads as Amazon's
  own domain. A host ending in a suffix on `RECOGNISED_PRIVATE_SUFFIXES` keeps that suffix plus
  one label, so the tenant-controlled label survives. The list is evidenced cases only, matched
  label for label; any other suffix gets the plain cut, and only a public suffix list would close
  the general case.

**[`grant-prompt-render.ts`](grant-prompt-render.ts): the claimed name is the first line of
`detail` and the origin the last, in every dialog that shows one.** `manifest.name` is the one
line an app fully controls and the origin the one it cannot fake, so they never sit side by side
(AR-03). `title` and `detail` carry the same elided origin, because Electron may not render
`title` at all (A127). *Provisional:* putting the claim just above the address would also leave
the origin last, but would recreate the adjacency this order removes, in the two lines a hurried
reader takes in right before clicking. Not done: a dedicated label (`Website: ...`) on the origin
line, which its isolation as the last line already sets apart; a label is polish, not a security
requirement.

**[`grant-prompt-render.ts`](grant-prompt-render.ts): every `tcp.listen.*` and `udp.bind.*`
row warns (A134, `ADR-0034`).** Being reached is never narrow enough to skip the warning. A
second, lower-severity marker for them was rejected: reaching out and being reached are
different kinds of exposure, not degrees of one. Rows that render the same headline merge, and
the `.network` listen and bind pair merges into one row; each alone still renders unmerged, which
the permissions list ([`../permissions/permissions.ts`](../permissions/permissions.ts)) relies on
for one revocable row per grant.

**[`grant-prompt-connect.ts`](grant-prompt-connect.ts): "and N other sites" warns from
`MAX_PATTERNS / 2` declared hosts (A133).** A digit-count threshold ("past 10") tripped on a
twelve-feed reader, a narrow declaration by any reading. Anchoring on half the enforced ceiling
([`../../broker/policy/connect.ts`](../../broker/policy/connect.ts)) leaves any curated list
clear and fires only where naming hosts has stopped being narrower than naming none.
Presentation, not policy: retune freely, as long as the threshold moves with `MAX_PATTERNS`.

**[`install-consent.ts`](install-consent.ts): skip the dialog only once nothing declared is left
unheld (A157).** `app.requestGrant` is a second door to a grant, open while the page's own
scripts run, so an app can hold one declared capability before install consent asks. Treating
"any declared capability held" as "already asked" would withhold every other one forever.

**[`install-consent.ts`](install-consent.ts) and
[`install-consent-prompt.ts`](install-consent-prompt.ts): the `'per-capability'` path (A138,
A162).** One `outstanding` filter (neither held nor declined) replaces the two whole-set checks,
which break once one sitting can accept part of a request and refuse the rest. The all-or-nothing
dialog still shows the whole declared set, so a person never under-reads what the app holds; the
per-capability one asks only about `outstanding`. The surface is a staged sequence of native
dialogs: one `Allow all` / `Choose individually` / `Deny all` overview, then one screen per
capability that still lists every capability being decided. A self-rendered checkbox window
would be a new privileged surface with its own `webPreferences` and CSP
([`../README.md`](../README.md) §Two things not to rediscover). *Provisional:* that window stays
the better answer if a true checkbox list is wanted. A refusal appends to the remembered-decline
record, never replaces it, so an earlier "no" nobody revisited survives.
