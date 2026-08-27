import { describe, expect, it } from 'vitest'
import { compareVersions, decideUpdate } from './update.js'
import type { PatternSet, UpdateDecision, UpdateInput } from './update.js'

// Security-critical, and the failure mode is SILENCE: the bug this suite
// exists to catch is "no prompt appeared". Nobody notices that by using the
// product -- the app simply works, holding more authority than the user
// granted (docs/development/testing.md SS5).
//
// MUTATION-TESTED 2026-08-26 against four deliberately-wrong implementations
// of decideUpdate, each the plausible mistake rather than a random edit. Every
// one is caught, and the row that catches it is named:
//
//   1. kind comparison instead of a subset check (the ORIGINAL wrong design,
//      corrected in capability-api.md A9 SS2)
//        -> "one granted host widens to *:* -- the journey 1 grant"
//        -> "an extra host is added to an already granted kind"
//        -> "a listen range widens at the top end"
//   2. the version floor check removed entirely (T19)
//        -> "an older bundle is replayed"
//        -> "a prerelease of the floor version is offered"
//        -> "an unorderable version cannot be proven newer"
//   3. the subset check reversed -- granted must be a subset of requested
//        -> "patterns narrow to a single host" (fails: prompts when it must not)
//        -> "one granted host widens to *:*" (fails: silent when it must prompt)
//   4. the coverage relation itself reversed, requested must cover granted
//        -> "one granted host widens to *:* -- the journey 1 grant"
//        -> "a listen range narrows to a single port"
//
// A passing suite proves nothing until it has been watched to fail.

const PINNED = 'a'.repeat(64)
const REBUILT = 'b'.repeat(64)

/** Defaults are the boring case: same code, same authority, a normal version. */
function update (overrides: Partial<UpdateInput>): UpdateInput {
  return {
    pinnedHash: PINNED,
    newHash: PINNED,
    grantedPatterns: {},
    newPatterns: {},
    version: '1.2.0',
    versionFloor: '1.2.0',
    ...overrides
  }
}

const ONE_HOST: PatternSet = { 'tcp.connect': ['api.example.com:443'] }
const ANY_HOST: PatternSet = { 'tcp.connect': ['*:*'] }

interface Row {
  readonly name: string
  readonly input: UpdateInput
  readonly decision: UpdateDecision
}

const TABLE: readonly Row[] = [
  {
    name: 'nothing changed at all',
    input: update({ grantedPatterns: ONE_HOST, newPatterns: ONE_HOST }),
    decision: 'silent'
  },
  {
    // ADR-0005: hash-pinning is the ONLY integrity mechanism in v0, so the pin
    // breaking is the signal. Same authority, different bytes.
    name: 'the bundle hash changed but the patterns are unchanged',
    input: update({ newHash: REBUILT, grantedPatterns: ONE_HOST, newPatterns: ONE_HOST }),
    decision: 'reconsent'
  },
  {
    name: 'the bundle hash changed and the patterns are a strict subset',
    input: update({
      newHash: REBUILT,
      grantedPatterns: { 'tcp.connect': ['api.example.com:443', 'cdn.example.com:443'] },
      newPatterns: ONE_HOST
    }),
    decision: 'reconsent'
  },

  // ---- the rows this file exists for -------------------------------------
  {
    // NO NEW CAPABILITY KIND IS REQUESTED HERE. Under a kind comparison this
    // installs silently and the user who granted "talk to one host" ends up
    // running an app that may "connect to any computer on the internet".
    name: 'one granted host widens to *:* -- the journey 1 grant',
    input: update({ newHash: REBUILT, grantedPatterns: ONE_HOST, newPatterns: ANY_HOST }),
    decision: 'capability-prompt'
  },
  {
    // The manifest is fetched from /.well-known/orivon.json, separately from
    // the bundle, so a host can widen it while serving byte-identical code.
    // An implementation that short-circuits on an unchanged hash misses this.
    name: 'the patterns widen while the bundle hash is unchanged',
    input: update({ grantedPatterns: ONE_HOST, newPatterns: ANY_HOST }),
    decision: 'capability-prompt'
  },
  {
    name: 'an extra host is added to an already granted kind',
    input: update({
      grantedPatterns: ONE_HOST,
      newPatterns: { 'tcp.connect': ['api.example.com:443', 'telemetry.example.net:443'] }
    }),
    decision: 'capability-prompt'
  },
  {
    name: 'a listen range widens at the top end',
    input: update({
      grantedPatterns: { 'tcp.listen': ['6881-6889'] },
      newPatterns: { 'tcp.listen': ['6881-7000'] }
    }),
    decision: 'capability-prompt'
  },

  // ---- new capability kinds ----------------------------------------------
  {
    name: 'a new capability kind appears alongside the granted one',
    input: update({
      newHash: REBUILT,
      grantedPatterns: ONE_HOST,
      newPatterns: { 'tcp.connect': ['api.example.com:443'], 'tcp.listen': ['6881-6889'] }
    }),
    decision: 'capability-prompt'
  },
  {
    // `id` carries no patterns, so its pattern list is empty. Absent and
    // present-but-empty are NOT the same thing: this is a new capability.
    name: 'a pattern-less capability kind appears',
    input: update({ grantedPatterns: ONE_HOST, newPatterns: { 'tcp.connect': ['api.example.com:443'], id: [] } }),
    decision: 'capability-prompt'
  },
  {
    name: 'a pattern-less capability kind that was already granted stays granted',
    input: update({ grantedPatterns: { fs: [] }, newPatterns: { fs: [] } }),
    decision: 'silent'
  },

  // ---- narrowing must NOT prompt -----------------------------------------
  {
    // Reversing the subset check makes this row prompt. Prompt fatigue trains
    // users to click through the one prompt that matters (ADR-0005), so a
    // false prompt is a real cost, not just noise.
    name: 'patterns narrow to a single host',
    input: update({ grantedPatterns: ANY_HOST, newPatterns: ONE_HOST }),
    decision: 'silent'
  },
  {
    name: 'a listen range narrows to a single port',
    input: update({
      grantedPatterns: { 'tcp.listen': ['6881-6889'] },
      newPatterns: { 'tcp.listen': ['6885'] }
    }),
    decision: 'silent'
  },
  {
    name: 'patterns narrow and the code changed too',
    input: update({ newHash: REBUILT, grantedPatterns: ANY_HOST, newPatterns: ONE_HOST }),
    decision: 'reconsent'
  },
  {
    name: 'a capability kind is dropped entirely',
    input: update({
      grantedPatterns: { 'tcp.connect': ['api.example.com:443'], 'tcp.listen': ['6881-6889'] },
      newPatterns: ONE_HOST
    }),
    decision: 'silent'
  },

  // ---- the version floor (T19) -------------------------------------------
  {
    // Validly hash-pinned -- it really is code this publisher shipped -- and
    // its pattern set is by construction one the user already accepted. Only
    // the floor catches it.
    name: 'an older bundle is replayed',
    input: update({
      newHash: REBUILT,
      version: '1.1.9',
      versionFloor: '1.2.0',
      grantedPatterns: ONE_HOST,
      newPatterns: ONE_HOST
    }),
    decision: 'reject'
  },
  {
    name: 'a prerelease of the floor version is offered',
    input: update({ newHash: REBUILT, version: '1.2.0-rc.1', versionFloor: '1.2.0' }),
    decision: 'reject'
  },
  {
    // Fails closed: "cannot prove this is not a rollback" and "is a rollback"
    // must reach the same outcome, or the floor is bypassed by publishing a
    // version string the parser cannot read.
    name: 'an unorderable version cannot be proven newer',
    input: update({ version: '1.x.0', versionFloor: '1.2.0' }),
    decision: 'reject'
  },
  {
    // The floor outranks every other signal, because no prompt can tell a
    // user whether the bundle in front of them is the replayed one.
    name: 'a rollback that also widens patterns is rejected, not prompted',
    input: update({
      version: '1.1.0',
      versionFloor: '1.2.0',
      grantedPatterns: ONE_HOST,
      newPatterns: ANY_HOST
    }),
    decision: 'reject'
  },
  {
    name: 're-fetching the installed version is not a rollback',
    input: update({ version: '1.2.0', versionFloor: '1.2.0', grantedPatterns: ONE_HOST, newPatterns: ONE_HOST }),
    decision: 'silent'
  },
  {
    name: 'a genuinely newer version with changed code',
    input: update({ newHash: REBUILT, version: '1.3.0', versionFloor: '1.2.0' }),
    decision: 'reconsent'
  },
  {
    // Semver: build metadata is not part of the ordering, so this is the same
    // version rather than a rollback.
    name: 'build metadata is not an ordering signal',
    input: update({ version: '1.2.0+build.99', versionFloor: '1.2.0+build.100' }),
    decision: 'silent'
  }
]

describe('decideUpdate', () => {
  it.each(TABLE)('$name -> $decision', ({ input, decision }) => {
    expect(decideUpdate(input)).toBe(decision)
  })

  it('covers every decision the type allows', () => {
    const produced = new Set(TABLE.map((row) => row.decision))
    expect([...produced].sort()).toEqual(['capability-prompt', 'reconsent', 'reject', 'silent'])
  })
})

// Stated separately from the table because it is the correction that this
// whole module records (capability-api.md A9 SS2, security-model.md T19). If
// this ever goes green under a kind comparison, the table above is decoration.
describe('the re-consent trigger is a subset check, not a kind comparison', () => {
  it('widening within one kind is caught even though the kind set is identical', () => {
    const grantedKinds = Object.keys(ONE_HOST)
    const requestedKinds = Object.keys(ANY_HOST)
    expect(requestedKinds).toEqual(grantedKinds)

    expect(decideUpdate(update({ grantedPatterns: ONE_HOST, newPatterns: ANY_HOST }))).toBe(
      'capability-prompt'
    )
  })

  it('a wildcard port on the same host is still a widening', () => {
    expect(
      decideUpdate(
        update({
          grantedPatterns: { 'tcp.connect': ['api.example.com:443'] },
          newPatterns: { 'tcp.connect': ['api.example.com:*'] }
        })
      )
    ).toBe('capability-prompt')
  })

  it('a subdomain wildcard does not cover a sibling domain', () => {
    expect(
      decideUpdate(
        update({
          grantedPatterns: { 'tcp.connect': ['*.example.com:443'] },
          newPatterns: { 'tcp.connect': ['api.evil-example.com:443'] }
        })
      )
    ).toBe('capability-prompt')
  })

  it('a subdomain wildcard does cover a subdomain', () => {
    expect(
      decideUpdate(
        update({
          grantedPatterns: { 'tcp.connect': ['*.example.com:443'] },
          newPatterns: { 'tcp.connect': ['api.example.com:443'] }
        })
      )
    ).toBe('silent')
  })

  it('a granted port range does not cover a host:port pattern of the same number', () => {
    // Different shapes: listening on 6881 is not permission to connect out to
    // some host's 6881. Anything the coverage relation does not positively
    // understand must prompt.
    expect(
      decideUpdate(
        update({
          grantedPatterns: { 'tcp.listen': ['6881'] },
          newPatterns: { 'tcp.listen': ['peer.example.com:6881'] }
        })
      )
    ).toBe('capability-prompt')
  })
})

// The manifest is a JSON document served by the party this check defends
// against, so the pattern set can be any shape at runtime -- the compiler's
// guarantees stop at the network boundary.
describe('publisher-controlled input cannot crash or bypass the check', () => {
  it('an unparseable pattern is not covered by anything', () => {
    expect(
      decideUpdate(
        update({
          grantedPatterns: { 'tcp.connect': ['*:*'] },
          newPatterns: { 'tcp.connect': ['api.example.com:99999'] }
        })
      )
    ).toBe('capability-prompt')
  })

  it('a __proto__ key is treated as an ungranted capability, not resolved through the prototype', () => {
    const hostile = JSON.parse('{"__proto__": ["*:*"]}') as PatternSet
    expect(decideUpdate(update({ grantedPatterns: {}, newPatterns: hostile }))).toBe(
      'capability-prompt'
    )
  })

  it('a non-array granted value grants nothing', () => {
    const malformed = JSON.parse('{"tcp.connect": "*:*"}') as PatternSet
    expect(decideUpdate(update({ grantedPatterns: malformed, newPatterns: ANY_HOST }))).toBe(
      'capability-prompt'
    )
  })

  it('a blank new hash is a changed bundle, never an unchanged one', () => {
    expect(decideUpdate(update({ pinnedHash: PINNED, newHash: '' }))).toBe('reconsent')
    expect(decideUpdate(update({ pinnedHash: '', newHash: '' }))).toBe('reconsent')
  })

  it('hash comparison ignores digest case and surrounding whitespace', () => {
    expect(decideUpdate(update({ pinnedHash: PINNED, newHash: `  ${PINNED.toUpperCase()}  ` }))).toBe(
      'silent'
    )
  })
})

// Exported so the broker computes the new floor -- max(floor, version) -- with
// this comparator rather than a second, divergent one written at that call
// site. A floor that disagrees with the check enforcing it is not a floor.
describe('compareVersions', () => {
  it.each([
    ['1.2.0', '1.2.0', 0],
    ['1.2.1', '1.2.0', 1],
    ['1.2.0', '1.2.1', -1],
    ['1.10.0', '1.9.0', 1],
    ['2.0.0', '1.99.99', 1],
    ['1.2', '1.2.0', 0],
    ['1.2.0-rc.1', '1.2.0', -1],
    ['1.2.0-rc.2', '1.2.0-rc.10', -1],
    ['1.2.0-alpha', '1.2.0-beta', -1],
    ['1.2.0-rc.1', '1.2.0-rc', 1],
    ['1.2.0+meta', '1.2.0', 0]
  ])('%s vs %s -> %s', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected)
  })

  it.each(['', '1.x.0', 'latest', '1..2', '1.2.0-', '1.2.0-rc 1', '1.2.0-!'])(
    'refuses to order %s',
    (version) => {
      expect(compareVersions(version, '1.2.0')).toBeNull()
      expect(compareVersions('1.2.0', version)).toBeNull()
    }
  )
})
