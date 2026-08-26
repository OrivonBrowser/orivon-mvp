# `scripts/` — build and CI guards

**What lives here.** Standalone Node scripts run by `package.json` and by CI. Each guard is an
exported pure function over a root directory, plus a CLI block — so it is unit testable without
running the build.

**What it depends on.** `node:*` builtins.

**What it must never import.** Anything under [`src/`](../src/). A guard that depended on the
code it guards could be disabled by the change it exists to catch.

| Script | Enforces |
|---|---|
| `check-no-native-modules.mjs` | **Rule 8.** No dependency may require a compiler at install time. Runs on `postinstall`, so it fires on every `npm install` |
| `check-contracts-pure.mjs` | `src/contracts/` is complete and references nothing outside itself |
| `smoke.mjs` | The shell actually launches and works, driven with real clicks |
| `devlog-cron.sh` | The Sunday devlog job |

**Reading `npm run smoke` output:** it prints a JSON result and a failure list. **Read those,
not the exit code alone.**
