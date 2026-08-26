# `apps/fixture/` — the test fixture app

**What lives here.** A minimal Orivon app: a real `/.well-known/orivon.json` and a frontend
that requests one capability and uses it.

**What it depends on.** Nothing. That is the point — it must be the smallest thing that is
still a real app.

**What it must never import.** Anything under `src/`.

**Owner stream.** `fixture-app` — testing. Independent of the critical path.

**It does three jobs at once:**
1. **The end-to-end smoke test.** Served over localhost HTTP, loaded via the app loader, grant
   accepted, `require('net')` **through the shim** connects to a local echo server and moves
   bytes — **and then the same app attempts a connection outside its manifest patterns and is
   rejected.** That last clause is the highest-value assertion in the whole plan: without it,
   nothing fails if capability enforcement degrades to allow-all.
2. **App #3** for the genericity test — evidence that Orivon runs apps, not one app.
3. **The developer-mode example** for journey 4.
