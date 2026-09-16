# Devlog journal — running capture

This file is the raw material for the Sunday devlog. It is append-only during the
week and compiled by `/devlog` into `devlog/updates/YYYY-MM-DD.md`, after which the
compiled week is cleared and a fresh week heading is started.

Three buckets per week:

- **Done / results** — technical outcomes worth telling the team. One line each.
- **In my head** — what the owner has been thinking about: doubts, direction changes,
  things circling that are not visible in commits. These become the voice-note cues.
- **Non-repo** — calls, Notion work, admin, anything outside this repository. Claude
  cannot see these, so the owner jots them here (or they get a placeholder on Sunday).

Mark anything that must not leave the team draft as `(Keep private)`.

---

## Week of 2026-09-14

### Done / results

- 2026-09-15: **The revoke button was lying.** Turn off an app's network access after a restart and
  the row disappeared, but a connection it already had open kept running. Fixed, with a test that
  fails against the old code.
- 2026-09-15: **Apps could die on startup because we refused too loudly.** Libraries routinely ask
  "does this browser have X?" before using it; we had started throwing at the question instead of
  answering it. Now the question is safe to ask and only actually using the missing thing fails.
- 2026-09-15: **Deny now means what it looks like it means.** The install prompt listed things the
  app had already been given, so saying no looked like it took them back. It marks those clearly.
- 2026-09-15: **Sixteen merged PRs had never been reviewed by anyone but their author.** Eight
  different review passes over them found nineteen things; the three serious ones are fixed.

### In my head

- **The review tools disagreed, and that is the whole point.** The security pass gave the range a
  clean bill of health while the worst bug in it sat there untouched -- a handle outliving its
  revocation just is not what a security-controls review looks at. Cheapest-tool-only would have
  shipped it.
- **We let the app decide how much choice the person gets.** Consent can be granted piece by piece
  only if the app's own manifest asks for that, and the app's incentive is always to ask for
  all-or-nothing. We already wrote down this exact trap about unlimited network access and did not
  apply it here.
- **Two files now sit within six lines of the size limit**, reached by separate PRs that were each
  fine on their own. The limit keeps breaking on merge rather than on a branch.

## Week of 2026-09-07

### Done / results

- 2026-09-06: **Closed step 2's known defects in four PRs (#89-#92).** The one that mattered:
  a socket connected to a peer that stops reading could survive both `close()` and a
  revoked permission, with no code path left able to reach it -- so "revoke means stop" was
  not actually true. Fixed with both shapes the owner picked, and the reproduction now runs
  as a test against a real paused TCP peer rather than sitting in a finding.
- 2026-09-06: **Two grant-policy decisions became code.** A blanket "any host, any port"
  grant no longer reaches the mail, DNS, IRC and remote-access ports unless an app names the
  exact port -- a range does not count as naming. And an app now declares how many
  connections it needs in its manifest, which the broker clamps and enforces; declaring
  nothing gets 64 rather than a silent 512, so anything heavy has to ask in a number the
  user will see.
- 2026-09-06: **A test that could pass against a stale build no longer can.** It rebuilt the
  bundle only when the file was missing, never when it was out of date, so a leftover build
  directory made it fail on a clean `main` -- and, worse, a slightly-stale one would have let
  it pass against code that predated the test.
- 2026-09-06: **src/broker/ is now five directories named for the job they do**, not 83 files
  in two flat folders. `policy/` decides, `grants/` remembers what the user approved,
  `handles/` holds what an app has open, `adapters/` is the only place a real address is
  dialled, `transport/` talks to the page. Tests moved into a `tests/` folder beside the code
  they cover -- half of what you scrolled past before was not the thing you were auditing.
  No behaviour change; 2813 tests identical before and after. Two stale path references that
  predated the move were found by the sweep and fixed.

- 2026-09-07: **A page can now ask for a UDP socket.** `orivon.net.udpBind` is real end to end --
  policy, a `node:dgram` adapter, a datagram relay over its own MessagePort, and `window.orivon`
  -- proved by a real Electron launch that round-trips a datagram against a real echo server and
  refuses an ungranted destination. Six stacked PRs (#95-#100). This is what unblocks the DHT, and
  with it build step 3's `dgram` shim: without it the torrent app could only find peers the way
  Chrome and Brave already can.
- 2026-09-07: **Step 2 turned out not to be finished.** `CLAUDE.md` said the only thing left was
  the permission prompt; the architecture docs said four of the six capability kinds had no code
  at all. The docs were right. UDP was the first of the four; `tcp.listen`, the rest of `fs` and
  `id` are still empty.
- 2026-09-10: **A real grant can now exist in production, for the first time.** `app.requestGrant`
  checks a request against the manifest, prompts, and calls `broker.grant()` for real on
  acceptance -- proven against a live broker, not a mock. Not reachable from a page yet (that
  wiring belongs to a parallel lane this batch); still the plumbing that makes every other
  capability's `'denied'` eventually turn into something that actually works.
- 2026-09-13: **The app loader could not install anything, at all -- fixed.** A same-day probe
  found real Electron's `net.fetch` reports `response.url` as empty on every ordinary response,
  which made the loader reject every fetch including honest ones. Fixed by trusting the requested
  URL instead, safe because a redirect can never produce a Response to inspect in the first
  place -- and, for the first time, a test now drives the real fetch adapter against a real
  server in a real Electron process, not a stub.
- 2026-09-13: **Build step 4 runs end to end for the first time.** A page can now discover
  itself as an app, get one real consent dialog, and load from local cache with the network
  unplugged. Two gaps stay open on purpose: a first visit can still race the dialog, and the
  shim's own globals still don't run in production.
- 2026-09-14: **Say no to an app now, and it stays said.** Declining install consent used to
  vanish the moment you restarted -- the same question, every single launch. Now it is
  remembered, but only ever as a "don't ask again," never as anything an app could turn into
  access on its own.
- 2026-09-14: **An app you already approved now just works, first try, after every restart.**
  It used to look broken -- images, fonts, live connections all silently failing -- until you
  refreshed the tab. Grants now come from the same verified bundle that already proves the app
  is unchanged, so nothing has to wait for the page to load first.

### In my head

- **Two documents had gone quietly false rather than wrong.** `CLAUDE.md` still said the
  build plan disagreed with itself after the amendment had already landed, and
  `handle-contracts.md` still said the renderer half of the backpressure design was unbuilt
  three days after it shipped. Neither was a mistake anyone made; both are what happens when
  a correction lands in one file and its citations elsewhere are nobody's job. Worth thinking
  about whether the file:line honesty problem (A50) is the same shape.
- **The owner answered a memory-limit question with a permissions answer.** Asked whether to
  cap 640 MB per app, the reply was that the app should declare what it needs and the user
  should see that number. That reframes a resource limit as a consent surface, which is the
  same move `fs.quotaBytes` already made for disk -- and it is a better answer than either
  option offered.

- **A test that passes locally and fails on CI is usually telling you about a shared resource.**
  Adding a second e2e file made two suites contend for the same fixture ports and the same
  Electron binary, and vitest runs files in parallel by default. Locally the interleaving happened
  to be benign, which is the least useful kind of green.
- **Three tests failed while I was writing them, and two of the three were the test's fault.**
  The UDP window overshoots by one datagram by design, and the drop timer reports a change rather
  than a total. Both times the tempting fix was to bend the code to the guess. Writing the
  reasoning into the code instead is what turned a wrong assertion into a documented property.
- **A landing this size needs its docs pass the same night, not as a follow-up.** Thirteen PRs
  in, six status-bearing documents were already describing a browser that couldn't install
  anything -- worth building the doc refresh into the same run next time.

### Non-repo
