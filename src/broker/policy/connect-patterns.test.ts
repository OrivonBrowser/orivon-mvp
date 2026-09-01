import { describe, expect, it } from 'vitest'
import { checkConnect, type Resolver } from './connect.js'
import { PUBLIC_A, PUBLIC_B, allowedAddresses, noResolution, resolverFor } from './connect.test-helpers.js'

// The grammar/validator half of checkConnect's suite (split out of one file
// that exceeded docs/development/code-guidelines.md's 800-line test limit --
// see ./connect.test.ts for the decision/orchestration half and the three
// original wrong implementations this suite was built to catch).
//
// Same discipline as ./connect.test.ts: every case goes through checkConnect
// with a stub resolver. The split makes a direct import of parsePattern,
// isCanonicalLiteral etc. newly possible -- do not take it. A matcher can be
// flawless and the check still fully defeated, so testing the matcher alone
// proves nothing about the check.
//
// WHAT WAS ACTUALLY MEASURED, stated as such. Thirteen hand-written mutants
// were run against this file (when it was still one file with ./connect.test.ts)
// and twelve failed. That is a fact about those thirteen, and an earlier
// version of this comment generalised it into a claim about the suite -- "one
// mutation survives" -- which was false.
//
// A review on 2026-08-27 found FIVE more surviving mutants, every one of them
// behaviour-changing, all in guards this file did not exercise:
//
//   1. host and port taken from DIFFERENT patterns  -> grants the cross
//      product of a multi-pattern manifest. The worst of the five.
//      -> "host and port must come from the SAME pattern"
//   2. the unbracketed-IPv6 reject in parsePattern  -> `::1:443` grants
//      loopback. -> "patterns that authorise nothing"
//   3. the `host.includes('*')` sub-glob reject     -> `*.example.com`
//      approximated. -> "patterns that authorise nothing"
//   4. the non-string answer guard                  -> a resolver answering
//      [42] throws instead of denying. -> "a resolver answer that is not a
//      string"
//   5. the MAX_HOST_LENGTH bound                    -> the row that tested it
//      passed a resolver that answered [], so the emptiness guard denied
//      first and the bound was never reached. -> "host handling"
//
// All five are now covered, each named in the test that kills it. The lesson
// is kept rather than tidied away: a table that reuses one fixed request
// cannot test a guard whose failure mode is "parses into a valid pattern
// pointing SOMEWHERE ELSE", because the fixed request does not match either
// way. Two of the five read as coverage for two years and were not.
//
// NO MUTATION IS CURRENTLY KNOWN TO SURVIVE. An earlier version of this file
// predicted one -- deleting the canonicality guard on resolver answers -- on
// the argument that every branch beneath it already rejected an unparseable
// answer. That argument was true of the OLD guard, which asked only whether
// ./address.ts could parse the string. The guard is now `isCanonicalLiteral`
// (./canonical-host.ts), which is strictly narrower: `0x08080808` parses fine
// and is not canonical. So the line is load-bearing after all, and deleting it
// fails tests in "the returned addresses are canonical literals".
//
// Stated as a measurement, not a guarantee, and the count for BOTH this file
// and ./connect.test.ts (they were one file until this split): sixteen mutants
// have been written and run -- the original thirteen, the five this review
// found on 2026-08-27, and one per guard added that day -- and all of them
// fail. That is a claim about sixteen mutants and nothing more; the next
// reader to think of a seventeenth should write it rather than trust this
// paragraph.

// ---------------------------------------------------------------------------
// Ports.
// ---------------------------------------------------------------------------

describe('ports', () => {
  const range = ['*:6881-6889']

  it.each([
    { port: 6880, allowed: false, why: 'one below the range' },
    { port: 6881, allowed: true, why: 'the first port in the range' },
    { port: 6885, allowed: true, why: 'inside' },
    { port: 6889, allowed: true, why: 'the last port -- inclusive, not exclusive' },
    { port: 6890, allowed: false, why: 'one above the range' }
  ])('port $port -> $allowed ($why)', async ({ port, allowed }) => {
    const decision = await checkConnect(range, PUBLIC_A, port, noResolution)
    expect(decision.allowed).toBe(allowed)
  })

  it('a single declared port matches only itself', async () => {
    const one = ['api.example.com:443']
    const resolve = resolverFor({ 'api.example.com': [PUBLIC_A] })
    expect((await checkConnect(one, 'api.example.com', 443, resolve)).allowed).toBe(true)
    expect((await checkConnect(one, 'api.example.com', 4433, resolve)).allowed).toBe(false)
    expect((await checkConnect(one, 'api.example.com', 80, resolve)).allowed).toBe(false)
  })

  it.each([80, 443, 22, 1023, 1024, 65535, 1])(
    'connect is NOT subject to the privileged-port rule: %i is allowed under `*:*`',
    async (port) => {
      // Ports below 1024 are denied outright for listen/bind (capability-api.md
      // A9 SS1). Copying that rule to connect would deny 80 and 443 and break
      // every outbound connection an app makes.
      const decision = await checkConnect(['*:*'], PUBLIC_A, port, noResolution)
      expect(decision.allowed).toBe(true)
    }
  )

  it.each([
    { port: 0, why: 'means "any free port" to bind, nothing to connect' },
    { port: -1, why: 'negative' },
    { port: 65536, why: 'one past the maximum' },
    { port: 1.5, why: 'not an integer' },
    { port: Number.NaN, why: 'NaN' },
    { port: Number.POSITIVE_INFINITY, why: 'Infinity' }
  ])('denies port $port even under `*:*` ($why)', async ({ port }) => {
    const decision = await checkConnect(['*:*'], PUBLIC_A, port, noResolution)
    expect(decision.allowed).toBe(false)
  })

  it.each([
    { pattern: '*:0', why: 'port 0 is not connectable' },
    { pattern: '*:0443', why: 'a leading zero means different things to different parsers' },
    { pattern: '*:abc', why: 'not a number' },
    { pattern: '*:-1', why: 'negative' },
    { pattern: '*:443-', why: 'an unterminated range' },
    { pattern: '*:-443', why: 'a headless range' },
    { pattern: '*:6889-6881', why: 'reversed bounds authorise nothing' },
    { pattern: '*:70000', why: 'past the maximum' },
    { pattern: '*: 443', why: 'whitespace inside the pattern, not around it' },
    { pattern: '*:4 43', why: 'whitespace in the middle of the number' },
    { pattern: '*:1-2-3', why: 'two hyphens' }
  ])('a pattern with port spec $pattern authorises nothing ($why)', async ({ pattern }) => {
    const decision = await checkConnect([pattern], PUBLIC_A, 443, noResolution)
    expect(decision.allowed).toBe(false)
  })

  it('trims whitespace around a whole pattern', async () => {
    // Lenient only at the edges, and harmlessly: `  *:*  ` declares exactly
    // what `*:*` declares, so trimming cannot widen a grant. Whitespace
    // anywhere else is rejected by the row above.
    const decision = await checkConnect(['  *:443  '], PUBLIC_A, 443, noResolution)
    expect(decision.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pattern grammar. Every unreadable pattern must remove authority, not grant
// it.
// ---------------------------------------------------------------------------

describe('patterns that authorise nothing', () => {
  it.each([
    { pattern: '*', why: 'no port part -- `*:*` is the wildcard, `*` alone is not' },
    { pattern: '6881-6889', why: 'a bare port range is a listen pattern, not a connect one' },
    { pattern: '', why: 'empty' },
    { pattern: '   ', why: 'whitespace' },
    { pattern: ':443', why: 'no host part' },
    { pattern: '*:', why: 'no port part' },
    { pattern: 'api.example.com', why: 'a host with no port' },
    { pattern: '*:*:*', why: 'a stray extra colon' },
    { pattern: '::1:443', why: 'unbracketed IPv6 is ambiguous with an address' },
    { pattern: '[::1:443', why: 'unterminated bracket' },
    { pattern: '[::1]443', why: 'bracket with no colon before the port' },
    { pattern: '[]:443', why: 'empty brackets' },
    { pattern: 'x'.repeat(400) + ':443', why: 'past the length bound' }
  ])('$pattern -> denied ($why)', async ({ pattern }) => {
    const resolve = resolverFor({ 'api.example.com': [PUBLIC_A] })
    const decision = await checkConnect([pattern], 'api.example.com', 443, resolve)
    expect(decision.allowed).toBe(false)
  })

  it('a sub-domain glob matches nothing rather than being approximated', async () => {
    // `*.example.com` looks obviously intended, and that is the danger: the
    // sibling reading, `*.co.uk`, spans a registry boundary. Denying costs the
    // app author seconds; an over-grant the user never sees costs more.
    const decision = await checkConnect(
      ['*.example.com:443'],
      'api.example.com',
      443,
      resolverFor({ 'api.example.com': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('MUTANT: the sub-glob reject is what denies it, not the host mismatch', async () => {
    // The row above reuses this table's fixed request, which does not match
    // `*.example.com` under ANY reading -- so deleting `host.includes('*')`
    // left it passing. The request here is the literal pattern text, which is
    // the one string a suffix-matcher and an exact-matcher disagree about.
    const decision = await checkConnect(
      ['*.example.com:443'],
      '*.example.com',
      443,
      resolverFor({ '*.example.com': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('MUTANT: the unbracketed-IPv6 reject is what denies `::1:443`', async () => {
    // Same defect as above. `::1:443` splits at the LAST colon into host `::1`
    // and port `443`, and `::1` is a perfectly good address literal -- so
    // deleting the `host.includes(':')` guard makes this pattern grant
    // loopback. The old table never asked for `::1`, so it never noticed.
    const decision = await checkConnect(
      ['::1:443'],
      '::1',
      443,
      noResolution
    )
    expect(decision.allowed).toBe(false)
  })

  it('an unreadable pattern does not poison a readable one beside it', async () => {
    const decision = await checkConnect(
      ['*.example.com:443', '[::1:80', '*:*'],
      'api.example.com',
      443,
      resolverFor({ 'api.example.com': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Host normalisation, and the arguments an app controls.
// ---------------------------------------------------------------------------

describe('host handling', () => {
  it.each([
    { pattern: 'API.Example.COM:443', host: 'api.example.com', why: 'pattern in mixed case' },
    { pattern: 'api.example.com:443', host: 'API.EXAMPLE.COM', why: 'argument in mixed case' },
    { pattern: 'api.example.com:443', host: 'api.example.com.', why: 'trailing root dot' },
    { pattern: 'api.example.com.:443', host: 'api.example.com', why: 'root dot in the pattern' },
    { pattern: 'api.example.com:443', host: '  api.example.com  ', why: 'surrounding whitespace' }
  ])('$why matches', async ({ pattern, host }) => {
    const decision = await checkConnect(
      [pattern],
      host,
      443,
      resolverFor({ 'api.example.com': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(true)
  })

  it.each([
    { host: '', why: 'empty' },
    { host: '   ', why: 'whitespace' },
    { host: 'a'.repeat(300) + '.example', why: 'past the DNS name limit' }
  ])('denies host $why', async ({ host }) => {
    // The resolver ANSWERS, and answers publicly. The earlier version of this
    // row passed `resolverFor({})`, which returns [] for an unknown name, so
    // the emptiness guard denied first and MAX_HOST_LENGTH was never reached
    // -- deleting the bound left this test passing. Found by review,
    // 2026-08-27.
    const decision = await checkConnect(
      ['*:*'],
      host,
      443,
      async () => [PUBLIC_A]
    )
    expect(decision.allowed).toBe(false)
  })

  it('the host-length bound is what denies an over-long name, not the resolver', async () => {
    const decision = await checkConnect(
      ['*:*'],
      'a'.repeat(300) + '.example',
      443,
      async () => [PUBLIC_A]
    )
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('bad-host')
  })

  it.each([
    { host: 'api.exämple.com', why: 'a Unicode label an app author would write' },
    { host: 'api.exKample.com', why: 'U+212A KELVIN SIGN -- toLowerCase folds it to k' }
  ])('denies a non-ASCII host: $why', async ({ host }) => {
    // Fails closed either way, but it used to fail closed SILENTLY and for the
    // wrong reason -- ASCII-only case folding simply never matched. Now it is
    // a deliberate reject with a reason the broker can log.
    const decision = await checkConnect(['*:*'], host, 443, async () => [PUBLIC_A])
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('bad-host')
  })

  it('denies a non-ASCII pattern rather than silently never matching it', async () => {
    const decision = await checkConnect(
      ['api.exämple.com:443'],
      'api.exämple.com',
      443,
      async () => [PUBLIC_A]
    )
    expect(decision.allowed).toBe(false)
  })

  it('denies a non-string host without throwing', async () => {
    for (const host of [undefined, null, 42, {}, ['a']]) {
      const decision = await checkConnect(
        ['*:*'],
        host as unknown as string,
        443,
        resolverFor({})
      )
      expect(decision.allowed).toBe(false)
    }
  })

  it('never throws on junk it has not seen', async () => {
    // Deterministic on purpose: a flaky security test gets deleted, and then
    // the property it guarded is not guarded by anything.
    const alphabet = '0123456789abcdefxX.:%[]*-+ \tg'
    let seed = 0x2545f491
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0
      return seed >>> 1
    }

    for (let i = 0; i < 400; i++) {
      let junk = ''
      const length = next() % 20
      for (let j = 0; j < length; j++) junk += alphabet[next() % alphabet.length] ?? ''

      const decision = await checkConnect(
        [junk, '*:*'],
        junk,
        (next() % 70000) - 2,
        resolverFor({ [junk]: [PUBLIC_A] })
      )
      expect(typeof decision.allowed).toBe('boolean')
    }
  })
})

// ---------------------------------------------------------------------------
// The five mutants a 2026-08-27 review found, and the guards added with them.
// Each test names the wrong implementation it kills.
// ---------------------------------------------------------------------------

describe('host and port must come from the SAME pattern', () => {
  it('MUTANT: denies the cross product of a two-pattern manifest', async () => {
    // The wrong shape is `patterns.some(hostOk) && patterns.some(portOk)`. It
    // reads identically, passed all 143 tests this suite had, and grants
    // a.example:8080 -- a combination the user granted for neither host.
    // The worst of the five, because a multi-pattern manifest is the normal
    // case for any app that is not the flagship.
    const decision = await checkConnect(
      ['a.example:443', 'b.example:8080'],
      'a.example',
      8080,
      resolverFor({ 'a.example': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('still allows each pattern on its own terms', async () => {
    // The guard above must not cost the legitimate case: both halves of the
    // same granted list still work at their own declared port.
    const patterns = ['a.example:443', 'b.example:8080']
    const resolve = resolverFor({ 'a.example': [PUBLIC_A], 'b.example': [PUBLIC_B] })
    expect((await checkConnect(patterns, 'a.example', 443, resolve)).allowed).toBe(true)
    expect((await checkConnect(patterns, 'b.example', 8080, resolve)).allowed).toBe(true)
    expect((await checkConnect(patterns, 'b.example', 443, resolve)).allowed).toBe(false)
  })

  it('MUTANT: denies the cross product even when the pre-resolution gate passes', async () => {
    // The row above is denied EARLY, by couldAnyPatternMatch, so on its own it
    // cannot see the same-pattern rule at all -- the cross-product mutant
    // survived it. This row gets past the gate: the literal pattern makes the
    // gate say "possible" (a name may resolve to a literal, which is the
    // nas.internal case), so the decision really is made by the loop below.
    //
    // The over-grant it describes is the sharp one: 8080 was granted for a
    // LAN device only, and a.example is a public host the user granted port
    // 443 for. Mixing them yields a public socket on a port nobody granted
    // publicly.
    const decision = await checkConnect(
      ['a.example:443', '192.168.1.50:8080'],
      'a.example',
      8080,
      resolverFor({ 'a.example': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('MUTANT: a port range from one pattern does not reach another pattern host', async () => {
    const decision = await checkConnect(
      ['tracker.example:6881-6889', 'api.example:443'],
      'api.example',
      6885,
      resolverFor({ 'api.example': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(false)
  })
})

describe('a resolver answer that is not a string', () => {
  it.each([
    { answer: 42, why: 'a number -- and 42 has no .trim()' },
    { answer: null, why: 'null' },
    { answer: undefined, why: 'undefined' },
    { answer: { toString: () => '93.184.216.34' }, why: 'an object that stringifies to a valid address' }
  ])('MUTANT: denies rather than throwing on $why', async ({ answer }) => {
    // Deleting the typeof guard turned this into `value.trim is not a
    // function` -- a broker crash reachable from any origin whose nameserver
    // an attacker controls. A throw here is not a denial; it is an outage.
    const decision = await checkConnect(
      ['*:*'],
      'odd.example',
      443,
      (async () => [answer]) as unknown as Resolver
    )
    expect(decision.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Every address that leaves here is a canonical literal. This is the half of
// the T12 mitigation the file always claimed and did not have.
// ---------------------------------------------------------------------------

describe('the returned addresses are canonical literals', () => {
  // net.isIP is deliberately NOT imported -- src/broker/policy/ may not touch
  // node:net (./README.md). This is the same predicate, written out, and the
  // point of the test is that a dialer using net.isIP will not re-resolve.
  const CANONICAL_V4 = /^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/
  function looksDialable (address: string): boolean {
    // A zone id makes net.isIP return 0, and a scoped address is not
    // internet-reachable anyway.
    if (address.includes('%')) return false
    if (address.includes(':')) {
      // IPv6, optionally ending in an embedded dotted quad (`::ffff:8.8.8.8`,
      // which net.isIP accepts as family 6 and which Node hands back for a
      // dual-stack lookup). Lower case only: RFC 5952 presentation form.
      const [head, ...rest] = address.split(':')
      void head
      const last = rest[rest.length - 1] ?? ''
      if (last.includes('.') && !CANONICAL_V4.test(last)) return false
      return /^[0-9a-f:.]+$/.test(address)
    }
    return CANONICAL_V4.test(address) && address.split('.').every((o) => Number(o) <= 255)
  }

  it.each([
    { host: '2130706433', why: 'loopback as one decimal integer' },
    { host: '0177.0.0.1', why: 'loopback with an octal octet' },
    { host: '127.1', why: 'an inet_aton short form' },
    { host: '0x7f.0.0.1', why: 'a hex octet' },
    { host: '16843009', why: 'a PUBLIC address as an integer -- 1.1.1.1' },
    { host: '0x08080808', why: 'a PUBLIC address in hex -- 8.8.8.8' }
  ])('denies a non-canonical address argument: $host ($why)', async ({ host }) => {
    // Verified before this guard existed: checkConnect returned the raw string,
    // net.isIP rejected it, and net.connect performed a SECOND DNS lookup that
    // landed on 127.0.0.1. The last two rows are public and would have been
    // allowed -- so this is not only about private ranges.
    const decision = await checkConnect(['*:*'], host, 443, noResolution)
    if (decision.allowed) throw new Error(`expected a denial, got ${JSON.stringify(decision.addresses)}`)
    expect(decision.reason).toBe('non-canonical-host')
  })

  it('a non-canonical address is NOT demoted to a hostname', async () => {
    // The dangerous fallthrough: if `2130706433` stopped counting as an
    // address it would be compared as a NAME against a `2130706433` pattern
    // host and match, which is worse than the bug being fixed.
    const decision = await checkConnect(
      ['2130706433:22'],
      '2130706433',
      22,
      noResolution
    )
    expect(decision.allowed).toBe(false)
  })

  it.each([
    '2130706433:22', '0177.0.0.1:22', '127.1:8080', '[::ffff:127.0.0.1]:22', '0x7f.0.0.1:22'
  ])('a manifest cannot declare a private range obfuscated as %s', async (pattern) => {
    // A literal declaration is the ONLY way a private range becomes reachable,
    // and the whole justification is that the user was shown the literal and
    // granted it. `2130706433:22` renders in a grant prompt as an opaque
    // number, which defeats the consent step the rule depends on.
    const decision = await checkConnect([pattern], '127.0.0.1', 22, noResolution)
    expect(decision.allowed).toBe(false)
  })

  it('the readable spelling of the same declaration still works', async () => {
    // The point is legibility, not blocking loopback: an app that says what it
    // means keeps working.
    const decision = await checkConnect(['127.0.0.1:22'], '127.0.0.1', 22, noResolution)
    expect(allowedAddresses(decision)).toStrictEqual(['127.0.0.1'])
  })

  it('denies a resolver answer in a non-canonical encoding', async () => {
    // A real resolver returns canonical forms; this asserts the guarantee is
    // local rather than inherited from that assumption.
    const decision = await checkConnect(
      ['*:*'],
      'odd.example',
      443,
      resolverFor({ 'odd.example': ['0x08080808'] })
    )
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('bad-answer')
  })

  it('denies an address carrying a zone id, which is never internet-reachable', async () => {
    const decision = await checkConnect(
      ['*:*'],
      'scoped.example',
      443,
      resolverFor({ 'scoped.example': ['2606:4700::1111%eth0'] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('every address of every allow is dialable without a second lookup', async () => {
    const allows = await Promise.all([
      checkConnect(['*:*'], PUBLIC_A, 443, noResolution),
      checkConnect(['*:*'], '[2606:4700::1111]', 443, noResolution),
      checkConnect(['*:*'], 'many.example', 443,
        resolverFor({ 'many.example': ['  93.184.216.34  ', '[2606:4700::1111]', '::ffff:8.8.8.8'] })),
      checkConnect(['127.0.0.1:22'], '127.0.0.1', 22, noResolution)
    ])
    for (const decision of allows) {
      for (const address of allowedAddresses(decision)) {
        expect(looksDialable(address), `${address} would be re-resolved by a dialer`).toBe(true)
      }
    }
  })
})
