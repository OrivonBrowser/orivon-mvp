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
// being narrower costs the app a fetch call, being wider costs the user the
// grant they refused, and only one of those is a security bug. CSP bounds
// NAMES; checkConnect bounds RESOLVED ADDRESSES -- the two diverge exactly
// on DNS rebinding (T12), and no CSP construction closes that. Test 29
// states this executably rather than just in prose.

function sources (granted: string[]): readonly string[] {
  return connectSrcFor(granted).sources
}

function omittedReasons (granted: string[]): readonly string[] {
  return connectSrcFor(granted).omitted.map((o) => o.reason)
}

describe('connectSrcFor -- base cases', () => {
  it('an empty grant is just self', () => {
    expect(sources([])).toEqual(["'self'"])
  })

  it('a non-array grant is just self, without throwing', () => {
    expect(sources(null as unknown as string[])).toEqual(["'self'"])
    expect(sources(undefined as unknown as string[])).toEqual(["'self'"])
  })

  it('over 256 patterns is just self -- mirrors checkConnect\'s too-many-patterns denial', () => {
    const many = Array.from({ length: 257 }, (_, i) => `host${i}.example:443`)
    expect(sources(many)).toEqual(["'self'"])
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

  it('duplicate patterns collapse to one source', () => {
    expect(sources(['a.example:443', 'a.example:443'])).toEqual(["'self'", 'a.example:443'])
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
    expect(result.omitted).toEqual([{ pattern: 'x.example:1-100', reason: 'port-not-enumerable' }])
  })

  it.each([
    '*:0', '*:0443', '*:abc', '*:-1', '*:443-', '*:-443', '*:6889-6881', '*:70000', '*: 443', '*:1-2-3'
  ])('an invalid port spec (%s) is omitted, not emitted', (pattern) => {
    // Same table connect-patterns.test.ts uses for portMatches -- the two
    // files must agree on what is unreadable.
    expect(sources([pattern])).toEqual(["'self'"])
  })
})

describe('connectSrcFor -- host: \'*\' has no safe CSP representation', () => {
  it('MUTANT: a `*` host is omitted, never rendered as CSP\'s bare `*`', () => {
    // The naive, dangerous implementation: emitting Pattern's '*' as CSP's
    // '*' literally. CSP's bare '*' permits loopback, link-local and the
    // whole LAN -- reach a `*` grant explicitly does NOT authorise
    // (connect-patterns.ts's own hostMatches: '*' means PUBLIC UNICAST ONLY).
    const result = connectSrcFor(['*:*'])
    expect(result.sources).toEqual(["'self'"])
    expect(result.sources).not.toContain('*')
    expect(result.omitted).toEqual([{ pattern: '*:*', reason: 'any-host' }])
  })

  it('a `*` host with a specific port is also omitted', () => {
    expect(sources(['*:443'])).toEqual(["'self'"])
  })
})

describe('connectSrcFor -- address literals', () => {
  it('a canonical private address literal is emitted -- the literal declaration IS the grant', () => {
    expect(sources(['192.168.1.50:8080'])).toEqual(["'self'", '192.168.1.50:8080'])
  })

  it('MUTANT: an IPv6 literal is re-bracketed, never emitted in the ambiguous unbracketed form', () => {
    // parsePattern strips brackets internally (host = text.slice(1, end)),
    // so naively emitting `${host}:${port}` produces `::1:443` -- the exact
    // unbracketed form parsePattern itself rejects as ambiguous with a
    // hostname containing a colon.
    const result = connectSrcFor(['[::1]:443'])
    expect(result.sources).toEqual(["'self'", '[::1]:443'])
    expect(result.sources).not.toContain('::1:443')
  })

  it.each([
    '2130706433:22', '0177.0.0.1:22', '127.1:8080', '0x7f.0.0.1:22'
  ])('a non-canonical address literal (%s) is omitted, not emitted', (pattern) => {
    // Reuses connect-patterns.test.ts's own table: a manifest cannot declare
    // a private range obfuscated as an opaque or non-canonical spelling, and
    // that must hold for CSP the same way it holds for checkConnect.
    expect(sources([pattern])).toEqual(["'self'"])
  })

  it('an IPv4-mapped IPv6 literal is emitted, re-bracketed -- it is its OWN canonical spelling', () => {
    // NOT the same case as the table above. connect-patterns.test.ts denies
    // checkConnect(['[::ffff:127.0.0.1]:22'], '127.0.0.1', ...) too, but for a
    // different reason entirely: hostMatches's address-literal branch compares
    // STRINGS, and '::ffff:127.0.0.1' !== '127.0.0.1' -- a family mismatch
    // against that test's requested address, not a non-canonical spelling.
    // address.ts's formatIpv6 deliberately renders ::ffff:0:0/96 in
    // dotted-quad form (RFC 5952 SS5), so canonicalAddress('::ffff:127.0.0.1')
    // returns the same string back: this IS the canonical spelling, and as a
    // GRANT (this file's question, not checkConnect's) it authorises exactly
    // what it says.
    expect(sources(['[::ffff:127.0.0.1]:22'])).toEqual(["'self'", '[::ffff:127.0.0.1]:22'])
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
    expect(result.omitted).toEqual([{ pattern: '*.example.com:443', reason: 'not-authorising' }])
  })

  it.each([
    { pattern: '*', why: 'no port part' },
    { pattern: '6881-6889', why: 'a bare port range is a listen pattern' },
    { pattern: '', why: 'empty' },
    { pattern: ':443', why: 'no host part' },
    { pattern: '::1:443', why: 'unbracketed IPv6 is ambiguous with a hostname' }
  ])('an unparseable pattern ($why) is omitted', ({ pattern }) => {
    expect(sources([pattern])).toEqual(["'self'"])
  })

  it('a non-ASCII host is omitted (A19)', () => {
    expect(sources(['api.exämple.com:443'])).toEqual(["'self'"])
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

  it('MUTANT: a host containing a semicolon is omitted, never emitted', () => {
    // A `;` closes the connect-src directive and starts a new one -- the
    // sharpest possible finding: a user-granted host injecting an entire
    // second CSP directive.
    const result = connectSrcFor(['a;report-uri https://evil.example/:443'])
    expect(result.sources).toEqual(["'self'"])
    for (const source of result.sources) {
      expect(source).not.toContain(';')
      expect(source).not.toContain(' ')
    }
  })

  it('every emitted source matches a strict host:port grammar, over randomised junk', () => {
    // Deterministic on purpose -- connect-patterns.test.ts's own fuzz uses
    // the same discipline: a flaky security test gets deleted, and then the
    // property it guarded is not guarded by anything.
    const HOST_PORT_RE = /^(?:'self'|(?:\[[0-9a-f:.]+\]|(?:[0-9]{1,3}\.){3}[0-9]{1,3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*):(?:\*|[1-9][0-9]{0,4}))$/
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
      for (const source of result.sources) expect(source).toMatch(HOST_PORT_RE)
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
      const hostMatches = sourceHost === (sourceHost.startsWith('[') ? `[${host}]` : host)
      const portMatches = sourcePort === '*' || sourcePort === String(port)
      if (hostMatches && portMatches) return true
    }
    return false
  }

  it.each([
    { granted: ['api.example.com:443'], host: 'api.example.com', port: 443, literal: false },
    { granted: ['tracker.example.com:6881-6889'], host: 'tracker.example.com', port: 6885, literal: false },
    { granted: ['192.168.1.50:8080'], host: '192.168.1.50', port: 8080, literal: true },
    { granted: ['x.example:*'], host: 'x.example', port: 12345, literal: false }
  ])('anything the generated CSP permits, checkConnect also permits (resolver answering publicly)', async ({ granted, host, port, literal }) => {
    const policy = connectSrcFor(granted)
    // The resolver answers PUBLICLY on purpose -- CSP is a name-level bound
    // and checkConnect is address-level; a hostname pattern's own DNS-
    // rebinding gap (T12) is real and this test does not paper over it by
    // resolving privately, which would make the comparison meaningless. An
    // address-literal host is never resolved at all (checkConnect's own
    // isLiteral shortcut), matching connect-patterns.test.ts's own use of
    // noResolution for exactly this case.
    const resolve = literal ? noResolution : resolverFor({ [host]: [PUBLIC_A] })
    const decision = await checkConnect(granted, host, port, resolve)

    if (cspAllows(policy.sources, host, port)) {
      expect(decision.allowed).toBe(true)
    }
  })

  it('a `*` grant: checkConnect allows a public address the generated CSP never permits (the documented gap)', async () => {
    // Confirms the *:*-is-omitted decision doesn't accidentally make CSP
    // wider than the grant by some other path -- checkConnect legitimately
    // allows this, and connectSrcFor legitimately does not represent it.
    const policy = connectSrcFor(['*:*'])
    const decision = await checkConnect(['*:*'], PUBLIC_B, 443, noResolution)

    expect(decision.allowed).toBe(true)
    expect(cspAllows(policy.sources, PUBLIC_B, 443)).toBe(false)
  })
})

describe('hostSpecKind agreement (the A27 guard)', () => {
  it.each([
    { spec: '*', kind: 'any-public-unicast' },
    { spec: '192.168.1.50', kind: 'address-literal' },
    { spec: '2130706433', kind: 'never' },
    { spec: '*.example.com', kind: 'never' },
    { spec: 'api.example.com', kind: 'hostname' }
  ])('$spec classifies as $kind', ({ spec, kind }) => {
    expect(hostSpecKind(spec)).toBe(kind)
  })
})
