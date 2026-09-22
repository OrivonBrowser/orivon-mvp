# `test/apps/fixture/`: the test fixture app

**What lives here.** A minimal Orivon app: a real `/.well-known/orivon.json` and a frontend
that requests one capability and uses it.

**What it depends on.** Nothing. That is the point: it must be the smallest thing that is
still a real app.

**What it must never import.** Anything under `src/`.

**Owner stream.** `fixture-app`, testing. Independent of the critical path.

**It does three jobs at once:**
1. **The end-to-end smoke test.** Served over localhost HTTP, loaded via the app loader, grant
   accepted, `require('net')` **through the shim** connects to a local echo server and moves
   bytes, **and then the same app attempts a connection outside its manifest patterns and is
   rejected.** That last clause is the highest-value assertion in the whole plan: without it,
   nothing fails if capability enforcement degrades to allow-all.
2. **App #3** for the genericity test: evidence that Orivon runs apps, not one app.
3. **The developer-mode example** for journey 4.

## What's here

```
apps/fixture/
  .well-known/orivon.json   the manifest -- exactly one capability: net.connect to the
                             echo server below, nothing wider
  index.html, app.js        the frontend: unstyled, no framework, no build step, written
                             directly against orivon.net.connect() (src/contracts/
                             capability-api.ts) -- orivon-node-shim (build step 3) does not
                             exist yet, so this must not assume any particular shim API
  config.mjs                the two servers' host/ports, in one place with no side effects
  echo-server.mjs           starts the TCP echo server
  serve.mjs                 starts the static file server for this directory
  manifest.test.ts          imports the real parseManifest() (src/loader/manifest.ts) and
                             checks the manifest above against it -- see "Testing" below
```

## Running it standalone

Two independent servers, no build step, no Electron:

```bash
node test/apps/fixture/echo-server.mjs   # TCP echo server on 127.0.0.1:8873
node test/apps/fixture/serve.mjs         # static file server on http://127.0.0.1:8872
```

Then open `http://127.0.0.1:8872/` in any browser. Both ports, and the loopback host,
are `apps/fixture/config.mjs`'s `HOST`/`ECHO_PORT`/`STATIC_PORT`; change them there, not by
hand-editing either script. **`.well-known/orivon.json`'s `capabilities.net.tcp.connect`
pattern must keep matching `HOST:ECHO_PORT` exactly** if you do: it is a static JSON file and
cannot import `config.mjs`, so the two can only be kept in sync by hand and by
`manifest.test.ts`, which asserts they agree.

The manifest declares `127.0.0.1`, never `localhost`, as an **address literal**, deliberately.
`src/broker/policy/connect-patterns.ts`'s `hostMatches` only authorises a *hostname* pattern
(like `"localhost:8873"`) against a resolved address that is `isPublicUnicast`, which loopback
never is; an address-literal pattern (`"127.0.0.1:8873"`) is instead compared directly against
the resolved address with no such restriction, since the user was shown and granted that literal
address. `localhost:8873` in the manifest would validate today (nothing wires the broker's
`net.connect` to real Node I/O yet; see the repo's `CLAUDE.md`) but would be silently unusable
the moment it did.

### What the frontend shows without an Orivon runtime

Almost every run, today: nothing wires this fixture to a real broker or app loader yet, so
`window.orivon` is simply absent in an ordinary browser tab. `app.js` checks for this rather
than assuming it: with no runtime, the page fetches its own manifest (plain `fetch`, which
needs no `orivon` object) to show what it *would* connect to, states plainly that no Orivon
runtime was detected, and stops there. It does not throw, and it does not silently do nothing.

With a real `window.orivon` present (once a loader exists, later), the page instead connects to
the declared host:port, writes one message, reads back exactly as many bytes as it sent (the
echo server has no framing, so the byte count is the only way to know the reply is complete), and
displays both strings side by side with a `match: true/false` line.

## Testing

`manifest.test.ts` imports the real `parseManifest()` rather than re-implementing the manifest
rules, and checks that the checked-in manifest is accepted, declares **exactly one**
`net.connect` pattern equal to `config.mjs`'s `HOST:ECHO_PORT`, and nothing else (no `listen`,
no `udp`, no `fs`, no `id`, no `protocols`), because the e2e out-of-manifest rejection test in
`test/e2e-capability-boundary.test.ts` depends on the manifest staying this narrow.

**No runner picks it up.** `vitest.config.ts`'s `include` is `src/**/*.test.ts` and
`scripts/**/*.test.ts`, and `test/vitest.e2e.config.ts` excludes `test/apps/**` so a pure
validator check does not sit behind an Electron build. Selecting it needs a config whose
`include` covers it: `vitest run <path>` does **not** bypass `include` (confirmed on vitest
4.1.11 -- it reports "No test files found").

**Provisional:** whether `test/apps/**/*.test.ts` should join `vitest.config.ts`'s `include`
is undecided. Adding it there would settle it, and would run this file under `npm test`.
