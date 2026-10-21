---
name: block-full-unit-suite-locally
enabled: true
event: bash
pattern: (?:\bnpm\s+(?:run\s+)?test(?::e2e)?|\bnpx\s+vitest(?:\s+run)?(?:\s+--?[\w=.-]+)*)(?=\s*(?:$|[;&|)]|\d?>))
action: block
---

**The whole unit suite and the whole e2e suite do not run locally: CI runs both on every pull request.**

The unit suite alone takes about five minutes on this machine and blocks every other heavy command
while it runs. For e2e, run the specs `node scripts/ci/select-e2e.mjs --base origin/main` names:
`npm run test:e2e -- <spec>`. For unit tests, run the ones your change can affect, through the
gate:

```bash
~/.claude/orivon-fleet/bin/heavy npm run test:changed 2>&1 | tail -6
```

`test:changed` takes the files that differ from `origin/main` (`-- --base <ref>` for another
base), runs the tests that import a changed code file and the tests that name a changed document,
and runs everything by itself when the dependencies, a tsconfig or the vitest config changed.
Name files to run them directly: `npx vitest run src/x/tests/y.test.ts`.

When the whole suite is the point (a change to a helper every test uses), say so and run
`npm run test:changed -- --all`.
