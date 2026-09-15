import { describe, expect, it } from 'vitest'
import type { PinCoverageSnapshot } from '../../src/loader/pin-coverage.js'
import type { PinCoverageEvidence } from '../../src/trust/delivery-ladder.js'

// docs/open-questions.md A179: src/loader/pin-coverage.ts's
// PinCoverageSnapshot and src/trust/delivery-ladder.ts's PinCoverageEvidence
// are deliberately duplicated -- src/trust/README.md forbids reaching into
// src/loader/'s internals, and src/loader/README.md does not list src/trust/
// among what it may import either, so sharing one type across the boundary
// is not an option. The defect A179 names is not the duplication itself but
// that nothing bound the two copies: add a field to one and the other
// silently does not get it, no test, typecheck or CI gate failing -- the
// exact failure mode scripts/check-manifest-parity.mjs exists to catch,
// reintroduced here two PRs later in a place its regex cannot reach (there
// is no hand-maintained array to diff a source file against; both sides ARE
// the source).
//
// This file lives here, not inside src/loader/ or src/trust/, for the same
// reason check-manifest-parity.mjs itself lives in scripts/ rather than in
// either src/contracts/ or src/loader/: comparing the two shapes requires
// importing both, and importing both from inside either stream's own
// directory would be exactly the boundary violation their READMEs forbid.
// scripts/ answers to neither stream.
//
// THE BINDING IS THE TYPE CHECK BELOW, NOT A RUNTIME ASSERTION. Follows the
// precedent src/loader/tests/manifest-contract-parity.test.ts set for A164:
// that file types one manifest fixture against `Required<Manifest>` so a
// contract field added anywhere in that chain without updating the fixture
// is an `npm run typecheck` failure, not a silent gap. There is no
// equivalent "real value" to construct for two result shapes that are never
// parsed from anything -- so the binding here is a direct structural
// equality between the two types themselves, not a fixture typed against
// one of them.
//
// A plain mutual `A extends B ? ... : ...` in each direction would NOT do
// this: TypeScript's structural typing already treats a type with EXTRA
// properties as assignable to a narrower one, so `A extends B` stays true
// when A merely gains a field B lacks -- only the OTHER direction
// (`B extends A`) would notice, and only for that one field. The
// distributive-conditional trick below (wrapping each side in a generic
// function type before comparing) does not have that blind spot: it fails
// to reduce to `true` for ANY difference between A and B -- an added field,
// a removed one, or one whose type changed -- on either side.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

/** Forces a type error at the call site unless `T` is exactly the literal `true`. */
type AssertEqual<T extends true> = T

// This line is the actual A179 guard: if PinCoverageSnapshot and
// PinCoverageEvidence ever diverge, Equals<...> reduces to `false`, `false`
// does not satisfy `extends true`, and `npm run typecheck` fails here by
// name -- see this lane's report for the reproduction where a field was
// temporarily added to one side only, proving this line actually breaks.
type _PinCoverageShapesStayBound = AssertEqual<Equals<PinCoverageSnapshot, PinCoverageEvidence>>

describe('PinCoverageSnapshot and PinCoverageEvidence stay field-for-field bound (A179)', () => {
  it('is proven above at compile time; this test only gives that proof a named, runnable location', () => {
    // The type-level check above IS the guard -- if this file still
    // compiles, the two independently-maintained shapes still match
    // exactly. There is nothing further to assert at runtime; this test
    // exists so `npx vitest run` and CI surface a readable pass/fail entry
    // for A179 rather than the guard's only visible effect being a
    // typecheck error with no obvious owner.
    const typeCheckOnly: _PinCoverageShapesStayBound = true
    expect(typeCheckOnly).toBe(true)
  })
})
