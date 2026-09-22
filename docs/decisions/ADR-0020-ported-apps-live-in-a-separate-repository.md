# ADR-0020: Ported third-party apps live in a separate repository

- **Status:** accepted; **amended 2026-09-22: the apps this repository's own tests serve moved
  to `test/apps/`, and there is no top-level `apps/` directory**, chosen by the owner
- **Date:** 2026-09-21
- **Type:** process
- **Decided by:** owner

> **Reversal recorded.** "Alternatives considered" below rejects **moving all of `apps/`**,
> on the ground that it would make this repository's test suite depend on a second checkout.
> The owner reversed the placement without reversing that ground: the fixture and the
> Orivon-native demo moved *down*, into `test/apps/`, not *out*. Nothing here gained a
> dependency on `orivon-ports`, so the reason the alternative was refused is still live -- and
> it is exactly why the destination is `test/apps/` and not the other repository. The rejected
> bullet is left as written, because it is the record this note refers to.

## Decision

Ported third-party applications live in `orivon-ports`, together with the harness that clones,
builds, prepares and serves them, and the porting guide. This repository keeps the shell, the
capability broker, the contracts, and only the apps its own test suite needs — the fixture and
the Orivon-native demo — which live under `test/apps/`, beside the suites that serve them.
There is no top-level `apps/` directory. The torrent flagship has no directory here;
`ADR-0001` and `build-plan.md` step 5 hold its design until it is built.

## Context

`apps/` held four directories that were four different kinds of thing. Three were the shell's
own: a broker and loader test fixture, an app written *for* Orivon as a contrast case, and the
flagship. One, the FreeTube port, was somebody else's application — cloned outside the
repository, built by its own toolchain, and reachable only through a machine-absolute path baked
into its own build script and into the test that drove it.

Keeping the port here cost three things. The absolute path made a fresh checkout unable to build
it. There was no home for the fetch/build/serve pipeline a port needs, so that pipeline was
written by hand for the one app that had it. And a second port would have re-derived all of it,
because the porting method existed as a skill — a document — rather than as a tool.

A port is also a different kind of artefact from a shell. It is a consumer of `orivon.*`, built
against the published capability surface, exactly as a third-party developer's app would be. It
has no privileged access to anything here.

## Alternatives considered

- **Move all of `apps/`.** The fixture has nine references across the e2e suite, the native
  demo is bundled from real files on disk by two more, and the flagship is an IN row in
  `mvp-scope.md` with its own ADR. Moving them would make this repository's test suite depend on
  a second checkout to run at all, in exchange for a tidier directory listing.
- **Keep everything here and add the harness under `scripts/`.** Cheaper today. It makes the
  shell repository the home of third-party build tooling, and it means every contributor who
  wants to port an app has to be given commit access to the browser.
- **Make the ports repository permissively licensed** so bridges could be reused more freely.
  That requires the `orivon.*` type definitions under a permissive licence too, which is a
  separate decision about `src/contracts/` and was not taken.

## Reasoning

The split follows a boundary that already existed. Nothing in the shell depends on a port at
runtime, because a port is just an origin: grants attach to the URL, so an app the browser has
never heard of behaves identically to one shipped beside it. The coupling is in the test suite.
Most of it was a path. It is not only a path: `test/e2e-freetube-real.test.ts` also asserts that
FreeTube's storage lands as nedb files at the app's own fs root, which is a claim about a bundle
built in the other repository. `open-questions.md` B5 carries that, and where those assertions
belong is unsettled.

Separating them also puts the porting work where its contributors are. The most useful
contribution to Orivon's app story is a port of an app somebody already uses, and that should not
require touching the browser.

## Consequences

- **This repository must build, test and ship with no `orivon-ports` checkout present.**
  `test/e2e-freetube-real.test.ts` skips when the sibling is absent, which is the behaviour it
  already had when the build was absent.
- The FreeTube e2e test now reads `ORIVON_PORTS_ROOT`, defaulting to a sibling checkout, and
  drives that repository's own executor rather than a server kept here.
- Two repositories must be released together when a capability changes shape, because a bridge
  compiled against the old surface will keep calling it.
- **CI here cannot prove a port still works.** It never checks out `orivon-ports`, so
  `test/e2e-freetube-real.test.ts` skips and a port's regression is green on this side. Proving
  it needs a sibling checkout in CI, which this decision does not set up.
- Documentation that cited `apps/freetube-real/` or the port recon now cites the other
  repository by name. Those references cannot be checked by a link checker here.
- `orivon-ports` is AGPL-3.0-only, matching this repository, so contracts and shared types can
  cross without analysis.
- `test/apps/` is carved out of the "anything under `test/` is a test file" definition in
  `../development/code-guidelines.md` Rule 2, in both guards and in the hookify comment rule.
  Without that carve-out the move would silently exempt the apps from `npm run check:comments`
  and raise their line limit from 500 to 800; they are app code that tests serve, not test code.
- `test/apps/fixture/manifest.test.ts` is excluded from `test/vitest.e2e.config.ts`, so a pure
  validator check does not sit behind an Electron build. No runner selects it; whether
  `test/apps/**/*.test.ts` should join `vitest.config.ts`'s include is **provisional**, and
  adding it there would settle it.

## Reversibility

- **Cost to reverse:** cheap. The ports repository has no history worth preserving separately
  and nothing here imports from it; folding it back is a directory copy and a path change.
- **What would make us revisit:** a port needing a privileged path a third-party app could not
  take. That would mean the capability API is not generic, which is a bigger finding than where
  the files live — and it would fail the genericity test in `mvp-scope.md` rather than this ADR.
