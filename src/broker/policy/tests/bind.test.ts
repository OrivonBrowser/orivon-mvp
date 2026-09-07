import { describe, expect, it } from 'vitest'
import { checkBind } from '../bind.js'
import { MAX_PATTERNS } from '../connect.js'

// The bind half of capability checking at the call site, and the half with no
// resolver in it -- so unlike connect.test.ts there is no DNS-rebinding story
// here. What replaces it is the EPHEMERAL case: bind(0) asks the OS to pick,
// and the whole question is whether it may pick outside what the user was
// shown.

/** Every denial is a bare 'denied' on the wire; only the local-log reason varies. */
function reasonOf (decision: ReturnType<typeof checkBind>): string {
  expect(decision.allowed).toBe(false)
  if (decision.allowed) throw new Error('unreachable')
  expect(decision.code).toBe('denied')
  return decision.reason
}

function rangesOf (decision: ReturnType<typeof checkBind>): ReadonlyArray<{ lo: number, hi: number }> {
  expect(decision.allowed).toBe(true)
  if (!decision.allowed) throw new Error(`expected allow, got ${decision.reason}`)
  return decision.ranges
}

describe('checkBind -- absence means absence', () => {
  it('denies an empty grant', () => {
    expect(reasonOf(checkBind([], 6881))).toBe('not-declared')
  })

  it('denies a non-array, because the ledger rehydrates untrusted JSON', () => {
    expect(reasonOf(checkBind('6881-6889' as unknown as string[], 6881))).toBe('not-declared')
  })

  it('denies more patterns than it will scan', () => {
    const many = Array.from({ length: MAX_PATTERNS + 1 }, () => '6881-6889')
    expect(reasonOf(checkBind(many, 6881))).toBe('too-many-patterns')
  })
})

describe('checkBind -- the requested port', () => {
  it('allows a port inside a granted range, narrowed to exactly that port', () => {
    expect(rangesOf(checkBind(['6881-6889'], 6885))).toEqual([{ lo: 6885, hi: 6885 }])
  })

  it('allows a single-port grant', () => {
    expect(rangesOf(checkBind(['6881'], 6881))).toEqual([{ lo: 6881, hi: 6881 }])
  })

  it('denies a port outside every granted range', () => {
    expect(reasonOf(checkBind(['6881-6889'], 6890))).toBe('no-pattern-match')
  })

  it('denies a privileged port even if a granted range somehow covered it', () => {
    // capability-api.md A9 SS1: below 1024 is denied outright at every tier.
    expect(reasonOf(checkBind(['1024-65535'], 80))).toBe('privileged-port')
  })

  it('denies a port that is not an integer in range', () => {
    expect(reasonOf(checkBind(['6881-6889'], 70000))).toBe('bad-port')
    expect(reasonOf(checkBind(['6881-6889'], -1))).toBe('bad-port')
    expect(reasonOf(checkBind(['6881-6889'], 6881.5))).toBe('bad-port')
    expect(reasonOf(checkBind(['6881-6889'], Number.NaN))).toBe('bad-port')
  })
})

describe('checkBind -- a granted pattern the manifest validator would have rejected', () => {
  // Each of these can only reach here through a corrupt ledger or a grant path
  // that bypassed validation. All fail closed; the reason exists so the broker
  // can log WHICH, since it is a sign of something wrong upstream.

  it('never honours "*", which would otherwise authorise every port', () => {
    expect(reasonOf(checkBind(['*'], 6881))).toBe('wildcard-pattern')
  })

  it('never honours a range reaching below 1024', () => {
    expect(reasonOf(checkBind(['500-2000'], 1500))).toBe('privileged-pattern')
  })

  it('does not clamp a privileged range to its unprivileged part', () => {
    // Clamping would silently convert a grant nobody could have approved into
    // a narrower one they also did not approve.
    expect(reasonOf(checkBind(['500-2000'], 1500))).not.toBe('no-pattern-match')
  })

  it('ignores an unreadable pattern but still honours a good one beside it', () => {
    expect(rangesOf(checkBind(['not-a-port', '6881-6889'], 6885))).toEqual([{ lo: 6885, hi: 6885 }])
  })

  it('denies when every pattern is unreadable', () => {
    expect(reasonOf(checkBind(['not-a-port'], 6885))).toBe('unparseable-pattern')
  })
})

describe('checkBind -- the ephemeral case (port 0)', () => {
  it('hands back the granted ranges to pick from, rather than denying', () => {
    expect(rangesOf(checkBind(['6881-6889'], 0))).toEqual([{ lo: 6881, hi: 6889 }])
  })

  it('hands back every granted range, in order', () => {
    expect(rangesOf(checkBind(['6881-6889', '30000-30010'], 0)))
      .toEqual([{ lo: 6881, hi: 6889 }, { lo: 30000, hi: 30010 }])
  })

  // THE POINT OF THE WHOLE EPHEMERAL BRANCH: an OS-chosen port must still land
  // inside what the person granting the capability actually read. Returning an
  // unbounded "any port" here would make the sentence they approved false.
  it('never authorises a port outside the declared ranges', () => {
    const ranges = rangesOf(checkBind(['6881-6889'], 0))
    expect(ranges.every((r) => r.lo >= 6881 && r.hi <= 6889)).toBe(true)
  })

  it('drops a privileged range from the ephemeral set rather than offering it', () => {
    expect(rangesOf(checkBind(['500-2000', '6881-6889'], 0))).toEqual([{ lo: 6881, hi: 6889 }])
  })

  it('denies when no usable range survives', () => {
    expect(reasonOf(checkBind(['500-2000'], 0))).toBe('privileged-pattern')
  })
})

describe('checkBind -- what it never does', () => {
  it('never returns an empty allow, which a caller would read as "bind anywhere"', () => {
    for (const port of [0, 6881, 6890, 80]) {
      const decision = checkBind(['6881-6889'], port)
      if (decision.allowed) expect(decision.ranges.length).toBeGreaterThan(0)
    }
  })

  it('never returns a range reaching below 1024', () => {
    const decision = checkBind(['1024-65535', '500-600'], 0)
    expect(rangesOf(decision).every((r) => r.lo >= 1024)).toBe(true)
  })
})
