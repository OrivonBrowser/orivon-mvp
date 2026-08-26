# `src/broker/policy/` — pure decision functions

**What lives here.** The security-critical decisions, as pure functions: capability matching,
private-address classification, path confinement, origin derivation, the update decision table.

**What it depends on.** [`src/contracts/`](../../contracts/) — types only.

**What it must never import.** **`electron`, `node:fs`, `node:net`, `node:dns`, or anything
that performs I/O.** This is not a style preference. It is a structural decision taken on day
one because taking it later costs a day of refactor exactly when the schedule is tightest
([`build-plan.md`](../../../docs/planning/build-plan.md) §Week 0).

The broker is constructed as `createBroker({ dial, resolve, now, fs, keychain })`. Every
capability test then runs against stubs, with no Electron and no network — which is what makes
the six security-critical unit tests in
[`docs/development/testing.md`](../../../docs/development/testing.md) cheap enough to actually
write.

**Owner stream.** `broker` — build step 2.

**Why this directory is separate from its parent.** Anything with an `import` of `electron`
belongs one level up, in `src/broker/`. If you find yourself wanting one here, the function is
doing two jobs: split the decision from the effect.
