import { describe, expect, it } from 'vitest'
import { checkConnect, type ConnectDecision, type Resolver } from './connect.js'
import type { Pattern } from '../../contracts/index.js'
import {
  PUBLIC_A,
  PUBLIC_B,
  PUBLIC_V6,
  allowedAddresses,
  noResolution,
  resolverFor
} from './connect.test-helpers.js'

// The decision/orchestration half of checkConnect's suite (split out of one
// file that exceeded docs/development/code-guidelines.md's 800-line test
// limit -- see ./connect-patterns.test.ts for the grammar/validator half).
//
// docs/development/testing.md SS1 says why this file exists and, more usefully,
// says what a test file here must NOT be: a test of the pattern matcher in
// isolation. A matcher can be flawless and the check still fully defeated, so
// every case below goes through checkConnect with a stub resolver, and the
// resolver is what makes the case interesting. That discipline holds in
// ./connect-patterns.test.ts too, even though the split makes a direct import
// of the pattern functions newly possible -- do not take it.
//
// THE THREE WRONG IMPLEMENTATIONS this suite exists to catch. Each was written
// and run against this file before it was committed; each fails the tests
// named beside it. A suite that has never been watched failing proves nothing.
//
//   1. Match the HOSTNAME the app supplied instead of the resolved address.
//      -> "the resolved address decides, not the name"
//   2. Check only the FIRST resolved address (or only the last).
//      -> "every resolved address must pass"
//   3. Let a private address through whenever some pattern matches.
//      -> "`*` means public unicast only" and "a hostname never authorises a
//         private address"
//
// A fourth, quieter one: `answers.every(ok)` with no emptiness guard, which is
// vacuously true. -> "a host that resolves to nothing is denied".
//
// Nine more were run: matching only the last address, `*` allowing private
// ranges, a hostname authorising a private range, applying the listen-only
// privileged-port rule to connect, an exclusive port range, approximating
// `*.example.com`, attaching a reason to the denial, and resolving twice. All
// nine failed here, most of them loudly.
//
// See ./connect-patterns.test.ts's header for the five mutants a 2026-08-27
// review found in the pattern grammar, and the sixteen-mutant tally -- that
// count spans both files and is written once, there, to avoid two files
// disagreeing about one number.

// ---------------------------------------------------------------------------
// 1. The whole point: the resolved address decides.
// ---------------------------------------------------------------------------

describe('the resolved address decides, not the name', () => {
  // Every row is a granted pattern list authorising the host being asked
  // for. A hostname matcher allows all of them.
  const REBOUND: ReadonlyArray<{ readonly to: string, readonly why: string }> = [
    { to: '127.0.0.1', why: 'loopback, the textbook rebind' },
    { to: '127.255.255.255', why: '127/8 is wider than 127.0.0.1' },
    { to: '10.0.0.1', why: 'RFC 1918' },
    { to: '172.16.0.1', why: 'RFC 1918, the /12 people get wrong' },
    { to: '192.168.1.1', why: 'the home router' },
    { to: '169.254.169.254', why: 'the cloud metadata endpoint' },
    { to: '0.0.0.0', why: 'unspecified' },
    { to: '::1', why: 'IPv6 loopback' },
    { to: 'fc00::1', why: 'IPv6 unique local' },
    { to: 'fe80::1', why: 'IPv6 link-local' },
    { to: '::ffff:127.0.0.1', why: 'IPv4-mapped loopback' },
    { to: '2130706433', why: 'loopback as one decimal integer' },
    { to: '0177.0.0.1', why: 'loopback with an octal octet' },
    { to: '2002:7f00:1::', why: '6to4 wrapped loopback' }
  ]

  it.each(REBOUND)('denies evil.example when it resolves to $to ($why)', async ({ to }) => {
    const decision = await checkConnect(
      ['evil.example:443'],
      'evil.example',
      443,
      resolverFor({ 'evil.example': [to] })
    )
    expect(decision.allowed).toBe(false)
  })

  it.each(REBOUND)('denies $to under `*:*` too ($why)', async ({ to }) => {
    const decision = await checkConnect(
      ['*:*'],
      'evil.example',
      443,
      resolverFor({ 'evil.example': [to] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('allows the same declaration when it resolves somewhere public', async () => {
    const decision = await checkConnect(
      ['api.example.com:443'],
      'api.example.com',
      443,
      resolverFor({ 'api.example.com': [PUBLIC_A] })
    )
    expect(allowedAddresses(decision)).toStrictEqual([PUBLIC_A])
  })

  it('denies a host that was never granted, however public it resolves', async () => {
    const decision = await checkConnect(
      ['api.example.com:443'],
      'other.example',
      443,
      resolverFor({ 'other.example': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('denies an address literal the app dials directly when only a name is declared', async () => {
    // The reverse of rebinding: the app skips DNS and names the address the
    // declared host happens to resolve to. Under a hostname declaration the
    // name has to match too, so this is denied -- the user granted "talk to
    // api.example.com", not "talk to whatever is at that IP today".
    const decision = await checkConnect(
      ['api.example.com:443'],
      PUBLIC_A,
      443,
      noResolution
    )
    expect(decision.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. All of them, not the first of them.
// ---------------------------------------------------------------------------

describe('every resolved address must pass', () => {
  const MIXED: ReadonlyArray<{ readonly answers: readonly string[], readonly why: string }> = [
    { answers: [PUBLIC_A, '127.0.0.1'], why: 'bad answer last -- caught only if the loop finishes' },
    { answers: ['127.0.0.1', PUBLIC_A], why: 'bad answer first -- caught only if the loop starts there' },
    { answers: [PUBLIC_A, '10.0.0.1', PUBLIC_B], why: 'bad answer in the middle' },
    { answers: [PUBLIC_A, PUBLIC_B, PUBLIC_V6, '::1'], why: 'one bad answer among many' },
    { answers: [PUBLIC_V6, '::ffff:169.254.169.254'], why: 'mixed family, v4-mapped metadata' }
  ]

  it.each(MIXED)('denies the whole connection: $why', async ({ answers }) => {
    const decision = await checkConnect(
      ['*:*'],
      'many.example',
      443,
      resolverFor({ 'many.example': answers })
    )
    expect(decision.allowed).toBe(false)
  })

  it('allows only when every answer is public', async () => {
    const decision = await checkConnect(
      ['*:*'],
      'many.example',
      443,
      resolverFor({ 'many.example': [PUBLIC_A, PUBLIC_B, PUBLIC_V6] })
    )
    expect(allowedAddresses(decision)).toStrictEqual([PUBLIC_A, PUBLIC_B, PUBLIC_V6])
  })

  it('denies a host that resolves to nothing', async () => {
    // `[].every(ok)` is true. A check written that way allows precisely the
    // host whose nameserver returned an empty answer.
    const decision = await checkConnect(
      ['*:*'],
      'empty.example',
      443,
      resolverFor({ 'empty.example': [] })
    )
    expect(decision.allowed).toBe(false)
  })

  it.each([
    { answer: 'localhost', why: 'a name, not an address' },
    { answer: 'example.com', why: 'a name that would be resolved again at connect()' },
    { answer: '', why: 'empty' },
    { answer: '999.999.999.999', why: 'not an address at all' },
    { answer: '127.0.0.1:8080', why: 'an address with a port glued on' }
  ])('denies when the resolver answers $answer ($why)', async ({ answer }) => {
    const decision = await checkConnect(
      ['*:*'],
      'odd.example',
      443,
      resolverFor({ 'odd.example': [answer] })
    )
    expect(decision.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. `*` is public unicast, and private ranges need an explicit declaration.
// ---------------------------------------------------------------------------

describe('`*` means public unicast only', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.5', '169.254.169.254',
    '100.64.0.1', '224.0.0.1', '255.255.255.255', '240.0.0.1',
    '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:192.168.1.1'
  ])('denies %s', async (address) => {
    const decision = await checkConnect(
      ['*:*'],
      address,
      443,
      noResolution
    )
    expect(decision.allowed).toBe(false)
  })

  it.each([PUBLIC_A, PUBLIC_B, '1.1.1.1', PUBLIC_V6, '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    'allows %s',
    async (address) => {
      const decision = await checkConnect(
        ['*:*'],
        address,
        443,
        noResolution
      )
      expect(decision.allowed).toBe(true)
    }
  )
})

describe('a private address needs an explicit literal declaration', () => {
  it('allows a declared private address, reached by name', async () => {
    // The legitimate case the deny-by-default must not destroy: the manifest
    // named the address, the grant prompt showed it, the user agreed.
    const decision = await checkConnect(
      ['192.168.1.50:5000'],
      'nas.internal',
      5000,
      resolverFor({ 'nas.internal': ['192.168.1.50'] })
    )
    expect(allowedAddresses(decision)).toStrictEqual(['192.168.1.50'])
  })

  it('allows a declared loopback address, dialled directly', async () => {
    const decision = await checkConnect(
      ['127.0.0.1:8080'],
      '127.0.0.1',
      8080,
      noResolution
    )
    expect(allowedAddresses(decision)).toStrictEqual(['127.0.0.1'])
  })

  it('allows a declared IPv6 loopback in bracket form', async () => {
    const decision = await checkConnect(
      ['[::1]:8080'],
      '[::1]',
      8080,
      noResolution
    )
    expect(allowedAddresses(decision)).toStrictEqual(['::1'])
  })

  it('denies the neighbour of a declared private address', async () => {
    const decision = await checkConnect(
      ['192.168.1.50:5000'],
      'nas.internal',
      5000,
      resolverFor({ 'nas.internal': ['192.168.1.51'] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('a hostname declaration never authorises a private address', async () => {
    // The tempting shortcut -- "the manifest named nas.internal and that is
    // where it resolves, so allow it" -- is the rebinding attack restated. A
    // name is never evidence that a range was intended; only the address is.
    const decision = await checkConnect(
      ['nas.internal:5000'],
      'nas.internal',
      5000,
      resolverFor({ 'nas.internal': ['192.168.1.50'] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('a declared private address does not widen `*`', async () => {
    const decision = await checkConnect(
      ['*:*', '192.168.1.50:5000'],
      'other.internal',
      5000,
      resolverFor({ 'other.internal': ['192.168.1.99'] })
    )
    expect(decision.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. A18 (docs/open-questions.md): checkConnect enforces exactly the list it
// was given, never a wider one that happened to exist somewhere upstream.
// ---------------------------------------------------------------------------

describe('checkConnect enforces the GRANTED list, not a wider declared one', () => {
  it('denies a pattern the manifest declared but the user did not grant', async () => {
    // The manifest DECLARES two patterns; the grant prompt showed both and the
    // user approved only the first one (capability-api.md A9 SS2). The broker
    // is required to narrow the manifest's declared connect list down to what
    // was actually granted before calling checkConnect -- that narrowing has
    // nowhere else to happen now that this function takes the list directly
    // rather than a whole Manifest it could read `net.tcp.connect` out of.
    const declared = ['*:*', '192.168.1.50:5000']
    const granted = declared.filter((pattern) => pattern !== '192.168.1.50:5000')

    const decision = await checkConnect(granted, '192.168.1.50', 5000, noResolution)
    expect(decision.allowed).toBe(false)

    // THE MUTATION THIS TEST EXISTS TO CATCH: passing the wider DECLARED list
    // instead of the narrowed GRANTED one -- the exact mistake A18 records,
    // and the one the old `checkConnect(manifest, ...)` signature made easy,
    // because a caller could pass the manifest it fetched and get this list
    // by accident. `192.168.1.50:5000` is a legitimate literal pattern (see
    // "a private address needs an explicit literal declaration" above), so
    // under the declared set the SAME request is allowed. The denial above
    // is not a property of the host or port; it depends entirely on which
    // array reached this function -- which is the whole point of the change.
    const declaredResult = await checkConnect(declared, '192.168.1.50', 5000, noResolution)
    expect(declaredResult.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Declaration absent means denied, never default-allow.
// ---------------------------------------------------------------------------

describe('absence means absence', () => {
  // BEFORE A18 (docs/open-questions.md), this block exercised checkConnect's
  // own reading of a whole Manifest -- seven capability shapes ("net declared,
  // tcp not", "udp.send does not imply tcp.connect", and so on) that all
  // reduced to one thing as far as this function is concerned: no `tcp.connect`
  // patterns. checkConnect no longer reads a Manifest at all -- it takes the
  // already-narrowed GRANTED pattern list directly (readonly Pattern[]) -- so
  // every one of those seven shapes now IS the same input, an empty array.
  // The shape questions (does the manifest declare `net.tcp`? does `listen`
  // imply `connect`?) belong to whatever builds that array from the manifest
  // and the grant store, which is not written yet (build step 2, the broker).
  it('denies an empty pattern list, never default-allows it', async () => {
    const decision = await checkConnect([], PUBLIC_A, 443, noResolution)
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('not-declared')
  })

  it('does not throw on a pattern list containing junk elements', async () => {
    // The MANIFEST-shape defensiveness this test used to cover (JSON fetched
    // off the network, so untrusted shape as well as untrusted content) moved
    // to the caller along with the parsing -- that is the point of A18. What
    // is still this function's job is not throwing on a per-element junk
    // pattern, and parsePattern already guards that (`typeof pattern !==
    // 'string'` -> null -> matches nothing). This is the regression test for
    // that path, run through checkConnect rather than parsePattern alone, per
    // this suite's own discipline.
    const junk = [undefined, null, 42, {}, ['a']] as unknown as Pattern[]
    const decision = await checkConnect(junk, PUBLIC_A, 443, noResolution)
    expect(decision.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 6. The denial tells the app nothing.
// ---------------------------------------------------------------------------

describe('the denial is uniform where uniformity has to hold', () => {
  // WHAT CHANGED, 2026-08-27. This block used to assert that every denial was
  // one byte-identical object carrying nothing but a code. That property was
  // real, but the comment justifying it also told the broker its denial log
  // "has everything it needs -- classifyAddress names the range", and that was
  // false: checkConnect owns the resolution, so the broker holds no addresses
  // and would have to resolve a SECOND time to log anything, which the header
  // forbids.
  //
  // So the reason moved into the result, marked local-log-only, mirroring
  // ./paths.ts which faced the same question. The probe-resistance property is
  // unchanged and still asserted -- it is a statement about what crosses IPC,
  // and that is what `appFacing` models here.

  /** What the broker is required to send an app: the code, and nothing else. */
  function appFacing (decision: ConnectDecision): unknown {
    if (decision.allowed) throw new Error('expected a denial')
    return { code: decision.code }
  }

  it('carries a code, a local-log reason, and nothing an app could read', async () => {
    const decision = await checkConnect(
      ['*:*'],
      'evil.example',
      443,
      resolverFor({ 'evil.example': ['127.0.0.1'] })
    )
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.code).toBe('denied')
    expect(decision.reason).toBe('no-pattern-match')
    // Never a platformCode: contracts/errors.ts forbids one on 'denied'.
    expect('platformCode' in decision).toBe(false)
    expect(Object.keys(decision).sort()).toStrictEqual(['allowed', 'checked', 'code', 'reason'])
  })

  it('is byte-identical across every reason once flattened for the app', async () => {
    // The probe-resistance property, asserted rather than asserted-about: an
    // app that varies host, port and address class must not be able to tell
    // the results apart, or it maps the user's LAN without completing a single
    // connection (../../contracts/errors.ts).
    const results = await Promise.all([
      checkConnect(['*:*'], 'a.example', 443, resolverFor({ 'a.example': ['127.0.0.1'] })),
      checkConnect(['*:*'], 'b.example', 443, resolverFor({ 'b.example': ['192.168.1.1'] })),
      checkConnect(['*:443'], PUBLIC_A, 8080, noResolution),
      checkConnect(['api.example.com:443'], 'other.example', 443, resolverFor({ 'other.example': [PUBLIC_A] })),
      checkConnect([], PUBLIC_A, 443, noResolution),
      checkConnect(['*:*'], PUBLIC_A, 0, noResolution),
      checkConnect(['*:*'], 'empty.example', 443, resolverFor({ 'empty.example': [] }))
    ])

    for (const result of results) {
      expect(result.allowed).toBe(false)
      expect(appFacing(result)).toStrictEqual({ code: 'denied' })
    }
  })

  it('every reason is one of the closed union, and they are distinguishable', async () => {
    // The union has to be exhaustive for the broker's logging switch, and the
    // reasons have to actually differ -- a union whose members all read
    // 'no-pattern-match' would be the old design wearing a new type.
    const seen = new Set<string>()
    const cases: Array<[readonly Pattern[], string, number, Resolver]> = [
      [[], PUBLIC_A, 443, noResolution],
      [Array.from({ length: 300 }, (_, i) => `h${i}.example:443`), PUBLIC_A, 443, noResolution],
      [['*:*'], PUBLIC_A, 0, noResolution],
      [['*:*'], '', 443, noResolution],
      [['*:*'], '2130706433', 443, noResolution],
      [['api.example.com:443'], 'other.example', 22, noResolution],
      [['*:*'], 'empty.example', 443, resolverFor({ 'empty.example': [] })],
      [['*:*'], 'many.example', 443, resolverFor({ 'many.example': Array.from({ length: 100 }, (_, i) => `93.184.0.${i}`) })],
      [['*:*'], 'odd.example', 443, resolverFor({ 'odd.example': ['localhost'] })],
      [['*:*'], 'priv.example', 443, resolverFor({ 'priv.example': ['127.0.0.1'] })]
    ]
    for (const [patterns, host, port, resolve] of cases) {
      const decision = await checkConnect(patterns, host, port, resolve)
      if (decision.allowed) throw new Error(`expected a denial for ${host}`)
      seen.add(decision.reason)
    }
    expect([...seen].sort()).toStrictEqual([
      'bad-answer', 'bad-host', 'bad-port', 'empty-resolution', 'no-pattern-match',
      'no-pattern-possible', 'non-canonical-host', 'not-declared', 'too-many-answers',
      'too-many-patterns'
    ])
  })
})

// ---------------------------------------------------------------------------
// 7. The allow result is what gets dialled.
// ---------------------------------------------------------------------------

describe('the allow result carries the validated literals', () => {
  it('returns every address, so the caller never names the host again', async () => {
    const decision = await checkConnect(
      ['*:*'],
      'many.example',
      443,
      resolverFor({ 'many.example': [PUBLIC_A, PUBLIC_B] })
    )
    expect(allowedAddresses(decision)).toStrictEqual([PUBLIC_A, PUBLIC_B])
  })

  it('returns them normalised and never returns the hostname', async () => {
    const decision = await checkConnect(
      ['*:*'],
      'many.example',
      443,
      resolverFor({ 'many.example': ['  93.184.216.34  ', '[2606:4700::1111]', '2606:4700::2222'] })
    )
    expect(allowedAddresses(decision)).toStrictEqual([PUBLIC_A, PUBLIC_V6, '2606:4700::2222'])
    expect(allowedAddresses(decision)).not.toContain('many.example')
  })
})

// ---------------------------------------------------------------------------
// 8. Resolution happens once, and only when it is needed.
// ---------------------------------------------------------------------------

describe('resolution', () => {
  it('resolves exactly once, whatever the pattern count', async () => {
    // Resolving per pattern would open a fresh rebinding window per pattern,
    // and the app chooses how many patterns there are.
    const resolve = resolverFor({ 'many.example': [PUBLIC_A, PUBLIC_B, PUBLIC_V6] })
    await checkConnect(
      ['a.example:443', 'b.example:443', '*:*', '10.0.0.1:22'],
      'many.example',
      443,
      resolve
    )
    expect(resolve.calls).toStrictEqual(['many.example'])
  })

  it('resolves the normalised name, so the name checked is the name looked up', async () => {
    const resolve = resolverFor({ 'api.example.com': [PUBLIC_A] })
    const decision = await checkConnect(
      ['api.example.com:443'],
      '  API.Example.COM.  ',
      443,
      resolve
    )
    expect(resolve.calls).toStrictEqual(['api.example.com'])
    expect(decision.allowed).toBe(true)
  })

  it('does not resolve an address literal', async () => {
    const resolve = resolverFor({})
    const decision = await checkConnect(['*:*'], PUBLIC_A, 443, resolve)
    expect(decision.allowed).toBe(true)
    expect(resolve.calls).toStrictEqual([])
  })

  it('does not swallow a resolver failure into a denial', async () => {
    // A DNS failure is 'unreachable' with a platformCode -- an attempt the app
    // was permitted to make. Reporting it as 'denied' would strip the errno
    // that honest Node retry logic branches on.
    const failing: Resolver = async () => { throw new Error('ENOTFOUND') }
    await expect(
      checkConnect(['*:*'], 'gone.example', 443, failing)
    ).rejects.toThrow('ENOTFOUND')
  })

  it('does not resolve at all when nothing was granted', async () => {
    const resolve = resolverFor({ 'api.example.com': [PUBLIC_A] })
    await checkConnect([], 'api.example.com', 443, resolve)
    expect(resolve.calls).toStrictEqual([])
  })
})

// ---------------------------------------------------------------------------
// 13. Nothing is resolved that could not possibly have been allowed.
// ---------------------------------------------------------------------------

describe('the pre-resolution gate', () => {
  it('does not resolve when no declared port could match', async () => {
    // Without this, a manifest declaring nothing but api.example.com:443 still
    // makes the user's machine resolve any name the app names, at any port,
    // for ever: unrestricted DNS reach that no manifest bounds and no grant
    // authorises -- a covert channel and a de-anonymising one (T20).
    const resolve = resolverFor({ 'printer.lan': ['192.168.1.9'] })
    const decision = await checkConnect(['api.example.com:443'], 'printer.lan', 22, resolve)
    expect(resolve.calls).toStrictEqual([])
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('no-pattern-possible')
  })

  it('does not resolve a name no hostname pattern names', async () => {
    const resolve = resolverFor({ 'gitlab.internal.corp': [PUBLIC_A] })
    await checkConnect(['api.example.com:443'], 'gitlab.internal.corp', 443, resolve)
    expect(resolve.calls).toStrictEqual([])
  })

  it('closes the name-existence oracle for requests that could never be allowed', async () => {
    // The two outcomes an app can tell apart are "denied" and "the resolver
    // threw". Before the gate, a manifest that could never authorise port 22
    // still distinguished a name that exists from one that does not, which is
    // exactly the LAN mapping the uniform denial exists to prevent.
    const resolve: Resolver = async (host) => {
      if (host === 'exists.lan') return ['192.168.1.7']
      throw new Error('getaddrinfo ENOTFOUND')
    }
    const patterns = ['api.example.com:443']
    const exists = await checkConnect(patterns, 'exists.lan', 22, resolve)
    const absent = await checkConnect(patterns, 'absent.lan', 22, resolve)
    expect(exists.allowed).toBe(false)
    expect(absent.allowed).toBe(false)
    // Same reason, and neither threw: indistinguishable to the app.
    expect((exists as { reason: string }).reason).toBe((absent as { reason: string }).reason)
  })

  it('STILL resolves when a `*` pattern is declared, because it must', async () => {
    // The gate answers "could this possibly be allowed", never "is it allowed".
    // A `*` pattern makes it true for every name -- that is correct, and the
    // real decision stays below, after the addresses are in hand.
    const resolve = resolverFor({ 'anything.example': ['127.0.0.1'] })
    const decision = await checkConnect(['*:*'], 'anything.example', 443, resolve)
    expect(resolve.calls).toStrictEqual(['anything.example'])
    expect(decision.allowed).toBe(false)
  })

  it('STILL resolves when an address-literal pattern is declared', async () => {
    // nas.internal -> 192.168.1.50 is the legitimate case the literal branch
    // exists for, and it cannot be ruled out from the name alone.
    const resolve = resolverFor({ 'nas.internal': ['192.168.1.50'] })
    const decision = await checkConnect(['192.168.1.50:5000'], 'nas.internal', 5000, resolve)
    expect(resolve.calls).toStrictEqual(['nas.internal'])
    expect(allowedAddresses(decision)).toStrictEqual(['192.168.1.50'])
  })
})

// ---------------------------------------------------------------------------
// 14. Counts are bounded, and the result is safe to hold.
// ---------------------------------------------------------------------------

describe('bounds and result hygiene', () => {
  it('denies a granted list with more patterns than the bound', async () => {
    // Item LENGTHS were bounded; item COUNTS were not, and the work is their
    // product. Measured before the bound: 20000 patterns x 1000 answers took
    // 13.9 SECONDS of synchronous CPU on the broker's UI thread (T11b).
    const many = Array.from({ length: 257 }, (_, i) => `h${i}.example:443`)
    const decision = await checkConnect(many, PUBLIC_A, 443, noResolution)
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('too-many-patterns')
  })

  it('denies a resolver answer set larger than the bound', async () => {
    const many = Array.from({ length: 65 }, (_, i) => `93.184.0.${i}`)
    const decision = await checkConnect(['*:*'], 'many.example', 443, async () => many)
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('too-many-answers')
  })

  it('a realistic manifest and answer set stay well inside the bounds', async () => {
    const decision = await checkConnect(
      ['*:6881-6889', 'tracker.example:443'],
      'many.example',
      6881,
      resolverFor({ 'many.example': [PUBLIC_A, PUBLIC_B, PUBLIC_V6] })
    )
    expect(allowedAddresses(decision)).toStrictEqual([PUBLIC_A, PUBLIC_B, PUBLIC_V6])
  })

  it('deduplicates repeated answers, so the caller opens one socket each', async () => {
    // The caller opens a socket per element against a documented cap
    // (LIMITS.concurrentSockets). A resolver repeating an address should not
    // spend three of them.
    const decision = await checkConnect(
      ['*:*'],
      'dup.example',
      443,
      resolverFor({ 'dup.example': [PUBLIC_A, PUBLIC_A, '  93.184.216.34  ', PUBLIC_B] })
    )
    expect(allowedAddresses(decision)).toStrictEqual([PUBLIC_A, PUBLIC_B])
  })

  it('the allow cannot be edited between the decision and the dial', async () => {
    // The gap between deciding and dialling is the only place a validated set
    // can be changed, and nothing downstream re-checks it.
    const decision = await checkConnect(['*:*'], PUBLIC_A, 443, noResolution)
    if (!decision.allowed) throw new Error('expected an allow')
    expect(Object.isFrozen(decision)).toBe(true)
    expect(Object.isFrozen(decision.addresses)).toBe(true)
    expect(() => { (decision.addresses as string[]).push('127.0.0.1') }).toThrow()
    expect(decision.addresses).toStrictEqual([PUBLIC_A])
  })
})
