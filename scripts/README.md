# `scripts/` — build and CI guards

**What lives here.** Standalone Node scripts run by `package.json` and by CI. Each guard is an
exported pure function over a root directory, plus a CLI block — so it is unit testable without
running the build.

`smoke.mjs` is the exception to that shape and to this directory's theme: it is the **shell's**
regression check, not a guard, it drives a real Electron app, and it is owned by the `shell`
stream rather than `packaging` ([`parallel-work.md`](../docs/development/parallel-work.md)).
It lives here because `npm run smoke` is where people look for it.

**What it depends on.** `node:*` builtins — plus, for `smoke.mjs` only, `playwright` via
[`test/launch-electron.mjs`](../test/launch-electron.mjs).

**What it must never import.** Anything under [`src/`](../src/). A guard that depended on the
code it guards could be disabled by the change it exists to catch.

| Script | Enforces |
|---|---|
| `check-no-native-modules.mjs` | **Rule 8.** No dependency may require a compiler at install time. Runs on `postinstall`, so it fires on every `npm install` |
| `check-contracts-pure.mjs` | `src/contracts/` is complete and references nothing outside itself |
| `check-no-secrets.mjs` | No credentials in git-tracked files |
| `smoke.mjs` | The shell actually launches and works, driven with real clicks |
| `devlog-cron.sh` | The Sunday devlog job |

**Reading `npm run smoke` output:** it prints a JSON result and a failure list. **Read those,
not the exit code alone.** That holds even when it breaks — a thrown error becomes a failed
check rather than replacing the output, and every click is bounded, so a broken run still names
what broke instead of dying with a bare stack trace.

**`npm run smoke` needs no network, and cannot use one.** It launches Electron with
`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`: nothing but loopback resolves. So it
passes air-gapped, nothing leaves the machine, and a change that made it depend on the network
fails loudly here rather than quietly phoning out. If you are tempted to let it reach the real
network, read the comment above the search check first: the address bar shows the *requested*
URL whether or not the load succeeded, so a round trip adds no coverage there and hands a third
party a veto over the build.

**Before changing a check in `smoke.mjs`, read the three rules in its header.** They are short,
each was learned by getting it wrong, and the second one — never wait for a condition the
pre-action state already satisfies — silently turned two checks into no-ops that reported green
while the regressions they existed to catch were present.
