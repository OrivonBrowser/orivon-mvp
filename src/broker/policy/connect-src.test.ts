import { describe, expect, it } from 'vitest'
import { appCspHeaderValue, connectSrcFor } from './connect-src.js'
import { checkConnect } from './connect.js'
import { hostSpecKind } from './connect-patterns.js'
import { PUBLIC_A, PUBLIC_B, noResolution, resolverFor } from './connect.test-helpers.js'

// Everything here is pure, so every case is a real input, no stubs -- same
// discipline as connect-patterns.test.ts. Reuses that file's own tables
// where the two must agree on what a pattern means.
//
// THE INVARIANT UNDER TEST: every emitted source names a (host, port) pair
// a single granted pattern names LITERALLY. Never wider than the grant --
// being wider costs the user the grant they refused, and that is the only
// one of the two directions that is a security bug. Being NARROWER is not
// free either: the emitted list is the app's ENTIRE connect-src allowlist,
// so an omitted pattern is BLOCKED, not merely "uncovered" -- decision 3's
// test group below is what proves every omission is reported, on every
// return path, so nothing is silently dropped. CSP bounds NAMES; checkConnect
// bounds RESOLVED ADDRESSES -- the two diverge exactly on DNS rebinding
// (T12), and no CSP construction closes that. The "agrees with checkConnect"
// group states this executably rather than just in prose.

function sources (granted: string[]): readonly string[] {
  return connectSrcFor(granted).sources
}

function omittedReasons (granted: string[]): readonly string[] {
  return connectSrcFor(granted).omitted.map((o) => o.reason)
}

describe('connectSrcFor -- base cases', () => {
  it('an empty grant is just self, with no omissions', () => {
    const result = connectSrcFor([])
    expect(result.sources).toEqual(["'self'"])
    expect(result.omitted).toEqual([])
  })

  it('a non-array grant is just self, and reports why -- once, not per pattern', () => {
    for (const bad of [null, undefined] as unknown as string[][]) {
      const result = connectSrcFor(bad)
      expect(result.sources).toEqual(["'self'"])
      expect(result.omitted).toEqual([{ reason: 'bad-grant' }])
    }
  })

  it('over MAX_PATTERNS is just self, and reports the whole grant as one omission -- not one per pattern', () => {
    // The whole-grant reasons name no single pattern (OmittedPattern.pattern
    // is optional exactly for this case): enumerating 100000 individual
    // entries here would be the same unbounded-work bug MAX_PATTERNS exists
    // to prevent, one function over.
    const many = Array.from({ length: 100000 }, (_, i) => `host${i}.example:443`)
    const result = connectSrcFor(many)
    expect(result.sources).toEqual(["'self'"])
    expect(result.omitted).toEqual([{ reason: 'too-many-patterns' }])
  })

  it('exactly MAX_PATTERNS (256) is NOT too-many-patterns -- the tail is over-budget instead', () => {
    const exactly256 = Array.from({ length: 256 }, (_, i) => `host${i}.example:443`)
    const result = connectSrcFor(exactly256)
    expect(result.omitted.every((o) => o.reason !== 'too-many-patterns')).toBe(true)
    expect(result.omitted.some((o) => o.reason === 'over-budget')).toBe(true)
  })

  it('appCspHeaderValue formats the header value for an empty grant', () => {
    expect(appCspHeaderValue([])).toBe("connect-src 'self'")
  })

  it('\'self\' is always first, even with real grants', () => {
    expect(sources(['api.example.com:443'])[0]).toBe("'self'")
  })
})

describe('connectSrcFor -- the clean case', () => {
  it('a literal host and single port emits exactly that source', () => {
    expect(sources(['api.example.com:443'])).toEqual(["'self'", 'api.example.com:443'])
  })

  it('normalises case and a trailing root dot the same way hostMatches would accept them', () => {
    expect(sources(['API.Example.COM.:443'])).toEqual(["'self'", 'api.example.com:443'])
  })

  it('two patterns produce two sources, in declaration order', () => {
    expect(sources(['a.example:443', 'b.example:8080'])).toEqual(["'self'", 'a.example:443', 'b.example:8080'])
  })

  it('duplicate patterns collapse to one source, and the duplicate is not reported as omitted', () => {
    const result = connectSrcFor(['a.example:443', 'a.example:443'])
    expect(result.sources).toEqual(["'self'", 'a.example:443'])
    expect(result.omitted).toEqual([])
  })

  it('never emits a scheme -- no source contains "://"', () => {
    for (const source of sources(['a.example:443', 'a.example:*'])) {
      expect(source).not.toContain('://')
    }
  })
})

describe('connectSrcFor -- ports', () => {
  it('a `*` port is exact, not a widening -- CSP\'s :* means the same thing the pattern does', () => {
    expect(sources(['x.example:*'])).toEqual(["'self'", 'x.example:*'])
  })

  it('a small port range enumerates every port, inclusive at both ends', () => {
    expect(sources(['tracker.example.com:6881-6889'])).toEqual([
      "'self'",
      'tracker.example.com:6881', 'tracker.example.com:6882', 'tracker.example.com:6883',
      'tracker.example.com:6884', 'tracker.example.com:6885', 'tracker.example.com:6886',
      'tracker.example.com:6887', 'tracker.example.com:6888', 'tracker.example.com:6889'
    ])
    // Exact boundaries: neither one below nor one above the range appears.
    expect(sources(['tracker.example.com:6881-6889'])).not.toContain('tracker.example.com:6880')
    expect(sources(['tracker.example.com:6881-6889'])).not.toContain('tracker.example.com:6890')
  })

  it('a range wider than the enumeration cap is omitted, not widened to :*', () => {
    const result = connectSrcFor(['x.example:1-100'])
    expect(result.sources).toEqual(["'self'"])
    expect(result.omitted).toEqual([{ pattern: 'x.example:1-100', reason: 'port-range-too-wide' }])
  })

  it.each([
    '0', '0443', 'abc', '-1', '443-', '-443', '6889-6881', '70000', ' 443', '1-2-3'
  ])('an invalid port spec (%s) on a real hostname is omitted as bad-port', (portSpec) => {
    // Host is a real hostname here, not `*` -- with `*` every case would exit
    // on hostSpecKind's any-public-unicast branch before portTokens is ever
    // called, which is exactly how bad-port went untested by the whole
    // suite in an earlier version of this file (host-first precedence, see
    // "connectSrcFor -- reason accuracy" below).
    expect(connectSrcFor([`x.example:${portSpec}`])).toEqual({
      sources: ["'self'"],
      omitted: [{ pattern: `x.example:${portSpec}`, reason: 'bad-port' }]
    })
  })
})

describe('connectSrcFor -- host: \'*\' has no safe CSP representation', () => {
  it('MUTANT: a `*` host is omitted, never rendered as CSP\'s bare `*`', () => {
    // The naive, dangerous implementation: emitting Pattern's '*' as CSP's
    // '*' literally. CSP's bare '*' permits loopback, link-local and the
    // whole LAN -- reach a `*` grant explicitly does NOT authorise
    // (connect-patterns.ts's own hostMatches: '*' means PUBLIC UNICAST ONLY).
    // This is decision 1 (2026-09-02, A43): the header stays this strict
    // even though it means the flagship's *:* grant gets no CSP coverage at
    // all -- see connect-src.ts's own header for why widening is worse.
    const result = connectSrcFor(['*:*'])
    expect(result.sources).toEqual(["'self'"])
    expect(result.sources).not.toContain('*')
    expect(result.omitted).toEqual([{ pattern: '*:*', reason: 'host-any-public-unicast' }])
  })

  it('a `*` host with a specific port is also omitted', () => {
    expect(sources(['*:443'])).toEqual(["'self'"])
  })

  it('host precedence: `*` with an invalid port reports the host reason, not bad-port', () => {
    // Matches checkConnect's own host-first evaluation order (connect.ts).
    expect(connectSrcFor(['*:abc'])).toEqual({
      sources: ["'self'"],
      omitted: [{ pattern: '*:abc', reason: 'host-any-public-unicast' }]
    })
  })
})

describe('connectSrcFor -- address literals', () => {
  it('a canonical private address literal is emitted -- the literal declaration IS the grant', () => {
    expect(sources(['192.168.1.50:8080'])).toEqual(["'self'", '192.168.1.50:8080'])
  })

  it.each([
    '2130706433:22', '0177.0.0.1:22', '127.1:8080', '0x7f.0.0.1:22'
  ])('a non-canonical address literal (%s) is omitted, not emitted', (pattern) => {
    // Reuses connect-patterns.test.ts's own table: a manifest cannot declare
    // a private range obfuscated as an opaque or non-canonical spelling, and
    // that must hold for CSP the same way it holds for checkConnect.
    expect(connectSrcFor([pattern])).toEqual({ sources: ["'self'"], omitted: [{ pattern, reason: 'host-authorises-nothing' }] })
  })

  it('a host over MAX_HOST_LENGTH is omitted as bad-host -- the same bound checkConnect enforces', async () => {
    // MAX_PATTERN_LENGTH (connect-patterns.ts) is 300, wider than
    // MAX_HOST_LENGTH (253, canonical-host.ts) -- without this bound a
    // 254-298 char host would pass the charset allowlist here while
    // checkConnect denies the identical host with bad-host. Paired with
    // checkConnect's own denial so the point -- the two now agree -- is
    // visible in one test rather than asserted separately in two files.
    const longHost = 'a'.repeat(280)
    const result = connectSrcFor([`${longHost}:443`])
    expect(result.sources).toEqual(["'self'"])
    expect(result.omitted).toEqual([{ pattern: `${longHost}:443`, reason: 'bad-host' }])

    const decision = await checkConnect([`${longHost}:443`], longHost, 443, resolverFor({ [longHost]: [PUBLIC_A] }))
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('bad-host')
  })

  it('a host at exactly MAX_HOST_LENGTH (253) is emitted; one character over is not', () => {
    const host253 = 'a'.repeat(253)
    const host254 = 'a'.repeat(254)
    expect(connectSrcFor([`${host253}:443`]).sources).toEqual(["'self'", `${host253}:443`])
    expect(connectSrcFor([`${host254}:443`]).omitted).toEqual([{ pattern: `${host254}:443`, reason: 'bad-host' }])
  })
})

describe('connectSrcFor -- IPv6: no safe CSP representation', () => {
  it('MUTANT: an IPv6 literal is omitted, never emitted -- CSP\'s host grammar has no `[`, `]` or `:`', () => {
    // A previous version of this file re-bracketed IPv6 literals and
    // emitted them as `[::1]:443`. That is not valid CSP: the grammar is
    // `host-char = ALPHA / DIGIT / "-"`, and Chromium enforces it --
    // confirmed in Electron 44.0.0 / Chrome 152 (2026-09-02), console:
    //   "The source list for the Content Security Policy directive
    //    'connect-src' contains an invalid source: '[::1]:8125'.
    //    It will be ignored."
    // The old test asserting the re-bracketed token was emitted was
    // asserting the defect -- it is inverted here.
    const result = connectSrcFor(['[::1]:443'])
    expect(result.sources).toEqual(["'self'"])
    expect(result.omitted).toEqual([{ pattern: '[::1]:443', reason: 'host-ipv6-literal' }])
    for (const source of result.sources) expect(source).not.toContain('[')
  })

  it('an IPv4-mapped IPv6 literal is ALSO omitted -- being its own canonical spelling does not make it valid CSP', () => {
    // address.ts's formatIpv6 deliberately renders ::ffff:0:0/96 in
    // dotted-quad form (RFC 5952 SS5), so canonicalAddress('::ffff:127.0.0.1')
    // returns the same string back and hostSpecKind classifies this
    // 'address-literal', exactly as the grant declares it. That settles
    // WHAT the pattern means (checkConnect's own question); it says nothing
    // about whether CSP can express it, and CSP's host grammar rejects any
    // host containing a colon regardless of what it means.
    expect(connectSrcFor(['[::ffff:127.0.0.1]:22'])).toEqual({
      sources: ["'self'"],
      omitted: [{ pattern: '[::ffff:127.0.0.1]:22', reason: 'host-ipv6-literal' }]
    })
  })

  it('a bracketed spec that is NOT valid IPv6 is bad-host, not mislabelled host-ipv6-literal', () => {
    // hostSpecKind classifies this 'hostname' (classifyAddress fails to
    // parse it as an address, and it has no '*'), so it must fall through
    // to HOSTNAME_RE and fail there -- not be caught by the IPv6 check,
    // which is gated on kind === 'address-literal' for exactly this reason.
    expect(connectSrcFor(['[a:b:c]:443'])).toEqual({
      sources: ["'self'"],
      omitted: [{ pattern: '[a:b:c]:443', reason: 'bad-host' }]
    })
  })
})

describe('connectSrcFor -- host specs that authorise nothing', () => {
  it('MUTANT: a sub-glob is omitted, never emitted verbatim', () => {
    // The single most dangerous naive pass-through: CSP DOES support
    // `*.example.com` as a real subdomain wildcard, so emitting it verbatim
    // would be syntactically valid CSP that is wider than a grant matching
    // nothing at all (connect-patterns.ts's own hostMatches: no sub-glob
    // support).
    const result = connectSrcFor(['*.example.com:443'])
    expect(result.sources).toEqual(["'self'"])
    expect(result.omitted).toEqual([{ pattern: '*.example.com:443', reason: 'host-authorises-nothing' }])
  })

  it.each([
    { pattern: '*', why: 'no port part' },
    { pattern: '6881-6889', why: 'a bare port range is a listen pattern' },
    { pattern: '', why: 'empty' },
    { pattern: ':443', why: 'no host part' },
    { pattern: '::1:443', why: 'unbracketed IPv6 is ambiguous with a hostname' }
  ])('a bad pattern ($why) is omitted as bad-pattern', ({ pattern }) => {
    expect(connectSrcFor([pattern])).toEqual({ sources: ["'self'"], omitted: [{ pattern, reason: 'bad-pattern' }] })
  })

  it('a non-ASCII host is omitted as bad-pattern (A19) -- isAsciiHost fires inside parsePattern, before the host/port split', () => {
    expect(connectSrcFor(['api.exämple.com:443'])).toEqual({
      sources: ["'self'"],
      omitted: [{ pattern: 'api.exämple.com:443', reason: 'bad-pattern' }]
    })
  })
})

describe('connectSrcFor -- the output allowlist (header-injection defence)', () => {
  it('MUTANT: a host containing a space is omitted, never emitted', () => {
    // isAsciiHost permits any printable ASCII, including space -- without an
    // output allowlist this would emit a token CSP reads as TWO sources,
    // silently granting the second one outright.
    const result = connectSrcFor(['a b.example:443'])
    expect(result.sources).toEqual(["'self'"])
    for (const source of result.sources) expect(source).not.toContain(' ')
  })

  it('MUTANT: a host containing a semicolon is omitted, never emitted -- exercised on a genuine hostname shape', () => {
    // 'a;report-uri https://evil.example/:443' (the original form of this
    // test) contains '://', so parsePattern rejects it at the unbracketed-
    // IPv6 guard before HOSTNAME_RE ever runs -- the allowlist this test is
    // named after was never actually exercised. This form reaches it: the
    // pattern splits cleanly into a hostname-shaped host and a numeric port,
    // and it is HOSTNAME_RE that must reject the semicolon.
    const pattern = 'a;b.example:443'
    const result = connectSrcFor([pattern])
    expect(result.sources).toEqual(["'self'"])
    expect(result.omitted).toEqual([{ pattern, reason: 'bad-host' }])
    for (const source of result.sources) {
      expect(source).not.toContain(';')
      expect(source).not.toContain(' ')
    }
  })

  it('every emitted source matches a strict host:port grammar, over randomised junk', () => {
    // Deterministic on purpose -- connect-patterns.test.ts's own fuzz uses
    // the same discipline: a flaky security test gets deleted, and then the
    // property it guarded is not guarded by anything. No bracket
    // alternative in this grammar -- an IPv6 source is never emitted at all.
    const HOST_PORT_RE = /^(?:'self'|(?:[0-9]{1,3}\.){3}[0-9]{1,3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*):(?:\*|[1-9][0-9]{0,4})$/
    const alphabet = '0123456789abcdefxX.:%[]*-+ \t;g'
    let seed = 0x2545f491
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0
      return seed >>> 1
    }

    for (let i = 0; i < 400; i++) {
      let junk = ''
      const length = next() % 20
      for (let j = 0; j < length; j++) junk += alphabet[next() % alphabet.length] ?? ''

      const result = connectSrcFor([junk, '*:*'])
      expect(result.sources.length).toBeLessThanOrEqual(128)
      for (const source of result.sources) {
        if (source === "'self'") continue
        expect(source).toMatch(HOST_PORT_RE)
        expect(source).not.toContain('[')
      }
    }
  })
})

describe('connectSrcFor -- budget: monotone and order-independent-except-by-design', () => {
  const filler = (n: number): string[] => Array.from({ length: n }, (_, i) => `h${i}.example:443`)

  it('once a pattern does not fit, EVERY later pattern is over-budget too -- even one that would fit alone', () => {
    // Fixes the non-monotonicity defect: the old budget check used
    // `continue` rather than latching, so a later small pattern could sneak
    // in after an earlier, larger one was rejected -- the emitted set
    // depended on evaluation order in a way nothing documented. 126 fillers
    // fill 127 of 128 slots; a 16-port range needs 16 more and does not fit,
    // so the single-port pattern after it must ALSO be rejected.
    const grant = [...filler(126), 'wide.example:1-16', 'small.example:443']
    const result = connectSrcFor(grant)
    expect(result.omitted).toEqual([
      { pattern: 'wide.example:1-16', reason: 'over-budget' },
      { pattern: 'small.example:443', reason: 'over-budget' }
    ])
  })

  it('the emitted set is a prefix of the grant, in grant order, once the budget is exceeded', () => {
    const grant = filler(140)
    const result = connectSrcFor(grant)
    expect(result.sources).toEqual(["'self'", ...filler(127)])
    expect(result.sources.length).toBe(128)
    expect(result.omitted.map((o) => o.pattern)).toEqual(grant.slice(127))
    expect(result.omitted.every((o) => o.reason === 'over-budget')).toBe(true)
  })

  it('appending a pattern never evicts an earlier one -- sources(grant) is always a prefix of sources(grant + extra)', () => {
    for (const size of [0, 1, 50, 126, 127, 128, 200]) {
      const grant = filler(size)
      const before = sources(grant)
      const after = sources([...grant, 'extra.example:443'])
      expect(after.slice(0, before.length)).toEqual(before)
    }
  })

  it('sources never exceeds MAX_CONNECT_SRC_SOURCES (128, counting \'self\')', () => {
    for (const size of [0, 1, 127, 128, 129, 200, 256]) {
      expect(sources(filler(size)).length).toBeLessThanOrEqual(128)
    }
  })

  it('the trap: a fully-subsumed later pattern does not fail, but a competing later one does', () => {
    // 126 fillers, then a single port taking the last slot, then a wildcard
    // for the SAME host that no longer fits. A REDUCE-before-BUDGET phase
    // would delete the single port's token in favour of the wildcard and
    // then reject the wildcard, silently erasing the single port too. The
    // ordered emit walk cannot: a token is only ever dropped in favour of
    // one already emitted, never a later one.
    const grant = [...filler(126), 'x.example:6881', 'x.example:*']
    const result = connectSrcFor(grant)
    expect(result.sources).toContain('x.example:6881')
    expect(result.omitted).toEqual([{ pattern: 'x.example:*', reason: 'over-budget' }])
  })
})

describe('connectSrcFor -- subsumption: a host:* absorbs the same host\'s narrower tokens', () => {
  it('wildcard first: the narrower range costs nothing and is not reported as omitted', () => {
    const result = connectSrcFor(['x.example:*', 'x.example:6881-6889'])
    expect(result.sources).toEqual(["'self'", 'x.example:*'])
    expect(result.omitted).toEqual([])
  })

  it('range first: the wildcard is a real, separate cost -- accepted asymmetry, pinned both ways', () => {
    const result = connectSrcFor(['x.example:6881-6889', 'x.example:*'])
    expect(result.sources).toEqual([
      "'self'",
      'x.example:6881', 'x.example:6882', 'x.example:6883', 'x.example:6884', 'x.example:6885',
      'x.example:6886', 'x.example:6887', 'x.example:6888', 'x.example:6889', 'x.example:*'
    ])
    expect(result.omitted).toEqual([])
  })
})

describe('connectSrcFor -- reason accuracy: one row per ConnectSrcOmissionReason member', () => {
  it.each([
    { pattern: '::1:443', reason: 'bad-pattern', why: 'unbracketed IPv6, unsplittable' },
    { pattern: 'a;b.example:443', reason: 'bad-host', why: 'semicolon fails the output allowlist' },
    { pattern: 'x.example:abc', reason: 'bad-port', why: 'not *, a port, or a range' },
    { pattern: '*.example.com:443', reason: 'host-authorises-nothing', why: 'sub-glob' },
    { pattern: '2130706433:22', reason: 'host-authorises-nothing', why: 'non-canonical address literal' },
    { pattern: '*:*', reason: 'host-any-public-unicast', why: 'no CSP equivalent for public-unicast-only' },
    { pattern: '[::1]:443', reason: 'host-ipv6-literal', why: 'CSP host grammar has no colon' },
    { pattern: 'x.example:1-100', reason: 'port-range-too-wide', why: 'over MAX_ENUMERATED_PORTS' },
    { pattern: 'api.exämple.com:443', reason: 'bad-pattern', why: 'A19: isAsciiHost fires before the host/port split' }
  ])('$pattern -> $reason ($why)', ({ pattern, reason }) => {
    expect(omittedReasons([pattern])).toEqual([reason])
  })

  it('bad-grant and too-many-patterns are reached only at the whole-grant level, never per-pattern', () => {
    expect(omittedReasons(null as unknown as string[])).toEqual(['bad-grant'])
    expect(omittedReasons(Array.from({ length: 257 }, (_, i) => `h${i}.example:443`))).toEqual(['too-many-patterns'])
  })
})

describe('connectSrcFor -- completeness: every granted pattern is emitted or reported, never dropped silently', () => {
  it('over a fuzz corpus, every pattern is either in omitted, or every token it would produce alone is in sources', () => {
    // The single property that would have caught W5, W4 and W1 together.
    // `connectSrcFor([pattern])` is used as an ORACLE for what that pattern
    // alone would produce -- translate() is a pure per-pattern map, so a
    // pattern's own tokens never depend on its neighbours in the grant, only
    // whether budget admits them. That makes this black-box: no need to
    // re-implement hostToken/portTokens here to know what a pattern "should"
    // produce.
    let seed = 0x9e3779b9
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0
      return seed >>> 1
    }
    const alphabet = '0123456789abcdefxX.:%[]*-;g'
    const randomPattern = (): string => {
      const length = next() % 24
      let s = ''
      for (let i = 0; i < length; i++) s += alphabet[next() % alphabet.length] ?? ''
      return s
    }

    for (let trial = 0; trial < 300; trial++) {
      const size = next() % 40
      const grant = Array.from({ length: size }, () => randomPattern())
      const result = connectSrcFor(grant)
      const omittedPatterns = new Set(result.omitted.map((o) => o.pattern))
      const emitted = new Set(result.sources)

      for (const pattern of grant) {
        const singletonTokens = connectSrcFor([pattern]).sources.filter((s) => s !== "'self'")

        if (singletonTokens.length === 0) {
          // translate() rejects this pattern regardless of context (it is
          // not a budget question) -- it MUST be reported, never silently
          // absent from both sources and omitted.
          expect(omittedPatterns.has(pattern)).toBe(true)
          continue
        }

        if (omittedPatterns.has(pattern)) continue // reported (budget), accounted for

        for (const token of singletonTokens) expect(emitted.has(token)).toBe(true)
      }
    }
  })
})

describe('connectSrcFor -- agrees with checkConnect (the invariant, executable)', () => {
  // A hand-written minimal CSP source-list matcher, deliberately NOT
  // imported from src/ -- same discipline as connect-patterns.test.ts's own
  // looksDialable ("this is the same predicate, written out"). Only needs to
  // handle the shapes connectSrcFor actually emits.
  function cspAllows (sourceList: readonly string[], host: string, port: number): boolean {
    for (const source of sourceList) {
      if (source === "'self'") continue
      const at = source.lastIndexOf(':')
      const sourceHost = source.slice(0, at)
      const sourcePort = source.slice(at + 1)
      const hostMatches = sourceHost === host
      const portMatches = sourcePort === '*' || sourcePort === String(port)
      if (hostMatches && portMatches) return true
    }
    return false
  }

  it.each([
    // outsidePort is null for the one row whose grant is a genuine port
    // wildcard -- there IS no port outside a `:*` grant, so no negative
    // control applies to it.
    { granted: ['api.example.com:443'], host: 'api.example.com', port: 443, literal: false, outsidePort: 444 },
    { granted: ['tracker.example.com:6881-6889'], host: 'tracker.example.com', port: 6885, literal: false, outsidePort: 7000 },
    { granted: ['192.168.1.50:8080'], host: '192.168.1.50', port: 8080, literal: true, outsidePort: 8081 },
    { granted: ['x.example:*'], host: 'x.example', port: 12345, literal: false, outsidePort: null }
  ])('anything the generated CSP permits, checkConnect also permits, and this grant IS fully represented', async ({ granted, host, port, literal, outsidePort }) => {
    const policy = connectSrcFor(granted)
    // Every row here is a grant CSP is supposed to cover in full -- assert
    // that first, or this test passes vacuously (as it did before) whenever
    // connectSrcFor regresses to returning just 'self'.
    expect(policy.omitted).toEqual([])
    expect(cspAllows(policy.sources, host, port)).toBe(true)

    // The resolver answers PUBLICLY on purpose -- CSP is a name-level bound
    // and checkConnect is address-level; a hostname pattern's own DNS-
    // rebinding gap (T12) is real and this test does not paper over it by
    // resolving privately, which would make the comparison meaningless. An
    // address-literal host is never resolved at all (checkConnect's own
    // isLiteral shortcut), matching connect-patterns.test.ts's own use of
    // noResolution for exactly this case.
    const resolve = literal ? noResolution : resolverFor({ [host]: [PUBLIC_A] })
    const decision = await checkConnect(granted, host, port, resolve)
    expect(decision.allowed).toBe(true)

    // Negative control in the other direction: a port genuinely outside the
    // grant must not be permitted by either side.
    if (outsidePort !== null) expect(cspAllows(policy.sources, host, outsidePort)).toBe(false)
  })

  it('a `*` grant: checkConnect allows a public address the generated CSP never permits (the documented gap)', async () => {
    // Confirms the *:*-is-omitted decision doesn't accidentally make CSP
    // wider than the grant by some other path -- checkConnect legitimately
    // allows this, and connectSrcFor legitimately does not represent it.
    const policy = connectSrcFor(['*:*'])
    const decision = await checkConnect(['*:*'], PUBLIC_B, 443, noResolution)

    expect(decision.allowed).toBe(true)
    expect(cspAllows(policy.sources, PUBLIC_B, 443)).toBe(false)
    expect(policy.omitted).toEqual([{ pattern: '*:*', reason: 'host-any-public-unicast' }])
  })
})

describe('hostSpecKind agreement (the A27 guard)', () => {
  it.each([
    { spec: '*', kind: 'any-public-unicast' },
    { spec: '192.168.1.50', kind: 'address-literal' },
    { spec: '2130706433', kind: 'authorises-nothing' },
    { spec: '*.example.com', kind: 'authorises-nothing' },
    { spec: 'api.example.com', kind: 'hostname' }
  ])('$spec classifies as $kind', ({ spec, kind }) => {
    expect(hostSpecKind(spec)).toBe(kind)
  })
})
