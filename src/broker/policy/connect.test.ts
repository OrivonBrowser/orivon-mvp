import { describe, expect, it } from 'vitest'
import { checkConnect, type ConnectDecision, type Resolver } from './connect.js'
import type { Capabilities, Manifest, Pattern } from '../../contracts/index.js'

// docs/development/testing.md SS1 says why this file exists and, more usefully,
// says what a test file here must NOT be: a test of the pattern matcher in
// isolation. A matcher can be flawless and the check still fully defeated, so
// every case below goes through checkConnect with a stub resolver, and the
// resolver is what makes the case interesting.
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
// WHAT WAS ACTUALLY MEASURED, stated as such. Thirteen hand-written mutants
// were run against this file and twelve failed. That is a fact about those
// thirteen, and an earlier version of this comment generalised it into a claim
// about the suite -- "one mutation survives" -- which was false.
//
// A review on 2026-08-27 found FIVE more surviving mutants, every one of them
// behaviour-changing, all in guards this file did not exercise:
//
//   1. host and port taken from DIFFERENT patterns  -> grants the cross
//      product of a multi-pattern manifest. The worst of the five.
//   2. the unbracketed-IPv6 reject in parsePattern  -> `::1:443` grants
//      loopback.
//   3. the `host.includes('*')` sub-glob reject     -> `*.example.com`
//      approximated.
//   4. the non-string answer guard                  -> a resolver answering
//      [42] throws instead of denying.
//   5. the MAX_HOST_LENGTH bound                    -> the row that tested it
//      passed a resolver that answered [], so the emptiness guard denied
//      first and the bound was never reached.
//
// All five are now covered, each named in the test that kills it. The lesson
// is kept rather than tidied away: a table that reuses one fixed request
// cannot test a guard whose failure mode is "parses into a valid pattern
// pointing SOMEWHERE ELSE", because the fixed request does not match either
// way. Rows 2 and 3 above read as coverage for two years and were not.
//
// NO MUTATION IS CURRENTLY KNOWN TO SURVIVE. The previous version of this file
// predicted one -- deleting the canonicality guard on resolver answers -- on
// the argument that every branch beneath it already rejected an unparseable
// answer. That argument was true of the OLD guard, which asked only whether
// ./address.ts could parse the string. The guard is now `isCanonicalLiteral`,
// which is strictly narrower: `0x08080808` parses fine and is not canonical.
// So the line is load-bearing after all, and deleting it fails three tests.
//
// Stated as a measurement, not a guarantee. Sixteen mutants have been written
// and run against this file -- the original thirteen, the five a review found
// on 2026-08-27, and one per guard added that day -- and all of them fail.
// That is a claim about sixteen mutants and nothing more; the next reader to
// think of a seventeenth should write it rather than trust this paragraph.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function manifestOf (capabilities: Capabilities): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.test',
    name: 'Test App',
    version: '0.1.0',
    entry: 'index.html',
    capabilities
  }
}

function manifestWith (connect: readonly Pattern[]): Manifest {
  return manifestOf({ net: { tcp: { connect } } })
}

interface StubResolver {
  (host: string): Promise<readonly string[]>
  readonly calls: string[]
}

/** Records what it was asked, so "resolve ONCE" is assertable and not assumed. */
function resolverFor (answers: Readonly<Record<string, readonly string[]>>): StubResolver {
  const calls: string[] = []
  const fn = async (host: string): Promise<readonly string[]> => {
    calls.push(host)
    return answers[host] ?? []
  }
  return Object.assign(fn, { calls })
}

const noResolution: Resolver = async () => {
  throw new Error('the resolver must not be called for an address literal')
}

function allowedAddresses (decision: ConnectDecision): readonly string[] {
  if (!decision.allowed) throw new Error('expected an allow, got a denial')
  return decision.addresses
}

const PUBLIC_A = '93.184.216.34'
const PUBLIC_B = '8.8.8.8'
const PUBLIC_V6 = '2606:4700::1111'

// ---------------------------------------------------------------------------
// 1. The whole point: the resolved address decides.
// ---------------------------------------------------------------------------

describe('the resolved address decides, not the name', () => {
  // Every row is a manifest that DECLARES the host being asked for, and a
  // grant the user really gave. A hostname matcher allows all of them.
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
      manifestWith(['evil.example:443']),
      'evil.example',
      443,
      resolverFor({ 'evil.example': [to] })
    )
    expect(decision.allowed).toBe(false)
  })

  it.each(REBOUND)('denies $to under `*:*` too ($why)', async ({ to }) => {
    const decision = await checkConnect(
      manifestWith(['*:*']),
      'evil.example',
      443,
      resolverFor({ 'evil.example': [to] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('allows the same declaration when it resolves somewhere public', async () => {
    const decision = await checkConnect(
      manifestWith(['api.example.com:443']),
      'api.example.com',
      443,
      resolverFor({ 'api.example.com': [PUBLIC_A] })
    )
    expect(allowedAddresses(decision)).toStrictEqual([PUBLIC_A])
  })

  it('denies a host the manifest never declared, however public it resolves', async () => {
    const decision = await checkConnect(
      manifestWith(['api.example.com:443']),
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
      manifestWith(['api.example.com:443']),
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
      manifestWith(['*:*']),
      'many.example',
      443,
      resolverFor({ 'many.example': answers })
    )
    expect(decision.allowed).toBe(false)
  })

  it('allows only when every answer is public', async () => {
    const decision = await checkConnect(
      manifestWith(['*:*']),
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
      manifestWith(['*:*']),
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
      manifestWith(['*:*']),
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
      manifestWith(['*:*']),
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
        manifestWith(['*:*']),
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
      manifestWith(['192.168.1.50:5000']),
      'nas.internal',
      5000,
      resolverFor({ 'nas.internal': ['192.168.1.50'] })
    )
    expect(allowedAddresses(decision)).toStrictEqual(['192.168.1.50'])
  })

  it('allows a declared loopback address, dialled directly', async () => {
    const decision = await checkConnect(
      manifestWith(['127.0.0.1:8080']),
      '127.0.0.1',
      8080,
      noResolution
    )
    expect(allowedAddresses(decision)).toStrictEqual(['127.0.0.1'])
  })

  it('allows a declared IPv6 loopback in bracket form', async () => {
    const decision = await checkConnect(
      manifestWith(['[::1]:8080']),
      '[::1]',
      8080,
      noResolution
    )
    expect(allowedAddresses(decision)).toStrictEqual(['::1'])
  })

  it('denies the neighbour of a declared private address', async () => {
    const decision = await checkConnect(
      manifestWith(['192.168.1.50:5000']),
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
      manifestWith(['nas.internal:5000']),
      'nas.internal',
      5000,
      resolverFor({ 'nas.internal': ['192.168.1.50'] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('a declared private address does not widen `*`', async () => {
    const decision = await checkConnect(
      manifestWith(['*:*', '192.168.1.50:5000']),
      'other.internal',
      5000,
      resolverFor({ 'other.internal': ['192.168.1.99'] })
    )
    expect(decision.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Ports.
// ---------------------------------------------------------------------------

describe('ports', () => {
  const range = manifestWith(['*:6881-6889'])

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
    const one = manifestWith(['api.example.com:443'])
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
      const decision = await checkConnect(manifestWith(['*:*']), PUBLIC_A, port, noResolution)
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
    const decision = await checkConnect(manifestWith(['*:*']), PUBLIC_A, port, noResolution)
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
    const decision = await checkConnect(manifestWith([pattern]), PUBLIC_A, 443, noResolution)
    expect(decision.allowed).toBe(false)
  })

  it('trims whitespace around a whole pattern', async () => {
    // Lenient only at the edges, and harmlessly: `  *:*  ` declares exactly
    // what `*:*` declares, so trimming cannot widen a grant. Whitespace
    // anywhere else is rejected by the row above.
    const decision = await checkConnect(manifestWith(['  *:443  ']), PUBLIC_A, 443, noResolution)
    expect(decision.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Declaration absent means denied, never default-allow.
// ---------------------------------------------------------------------------

describe('absence means absence', () => {
  it.each([
    { capabilities: {}, why: 'no capabilities at all' },
    { capabilities: { net: {} }, why: 'net declared, tcp not' },
    { capabilities: { net: { tcp: {} } }, why: 'tcp declared, connect not' },
    { capabilities: { net: { tcp: { connect: [] } } }, why: 'connect declared empty' },
    { capabilities: { net: { tcp: { listen: ['6881-6889'] } } }, why: 'listen does not imply connect' },
    { capabilities: { net: { udp: { send: ['*:*'] } } }, why: 'udp.send does not imply tcp.connect' },
    { capabilities: { fs: { quotaBytes: 1 } }, why: 'an unrelated capability' }
  ])('denies with $why', async ({ capabilities }) => {
    const decision = await checkConnect(manifestOf(capabilities), PUBLIC_A, 443, noResolution)
    expect(decision.allowed).toBe(false)
  })

  it('denies when the manifest is structurally junk', async () => {
    // The manifest is JSON fetched off the network, so its SHAPE is untrusted
    // too. A throw here would be a broker crash reachable from any origin.
    const junk = [
      undefined,
      null,
      {},
      { capabilities: null },
      { capabilities: { net: { tcp: { connect: 'not-an-array' } } } },
      { capabilities: { net: { tcp: { connect: [null, 42, {}] } } } }
    ]

    for (const manifest of junk) {
      const decision = await checkConnect(
        manifest as unknown as Manifest,
        PUBLIC_A,
        443,
        noResolution
      )
      expect(decision.allowed).toBe(false)
    }
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
      manifestWith(['*:*']),
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
      checkConnect(manifestWith(['*:*']), 'a.example', 443, resolverFor({ 'a.example': ['127.0.0.1'] })),
      checkConnect(manifestWith(['*:*']), 'b.example', 443, resolverFor({ 'b.example': ['192.168.1.1'] })),
      checkConnect(manifestWith(['*:443']), PUBLIC_A, 8080, noResolution),
      checkConnect(manifestWith(['api.example.com:443']), 'other.example', 443, resolverFor({ 'other.example': [PUBLIC_A] })),
      checkConnect(manifestOf({}), PUBLIC_A, 443, noResolution),
      checkConnect(manifestWith(['*:*']), PUBLIC_A, 0, noResolution),
      checkConnect(manifestWith(['*:*']), 'empty.example', 443, resolverFor({ 'empty.example': [] }))
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
    const cases: Array<[Manifest, string, number, Resolver]> = [
      [manifestOf({}), PUBLIC_A, 443, noResolution],
      [manifestWith(Array.from({ length: 300 }, (_, i) => `h${i}.example:443`)), PUBLIC_A, 443, noResolution],
      [manifestWith(['*:*']), PUBLIC_A, 0, noResolution],
      [manifestWith(['*:*']), '', 443, noResolution],
      [manifestWith(['*:*']), '2130706433', 443, noResolution],
      [manifestWith(['api.example.com:443']), 'other.example', 22, noResolution],
      [manifestWith(['*:*']), 'empty.example', 443, resolverFor({ 'empty.example': [] })],
      [manifestWith(['*:*']), 'many.example', 443, resolverFor({ 'many.example': Array.from({ length: 100 }, (_, i) => `93.184.0.${i}`) })],
      [manifestWith(['*:*']), 'odd.example', 443, resolverFor({ 'odd.example': ['localhost'] })],
      [manifestWith(['*:*']), 'priv.example', 443, resolverFor({ 'priv.example': ['127.0.0.1'] })]
    ]
    for (const [manifest, host, port, resolve] of cases) {
      const decision = await checkConnect(manifest, host, port, resolve)
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
      manifestWith(['*:*']),
      'many.example',
      443,
      resolverFor({ 'many.example': [PUBLIC_A, PUBLIC_B] })
    )
    expect(allowedAddresses(decision)).toStrictEqual([PUBLIC_A, PUBLIC_B])
  })

  it('returns them normalised and never returns the hostname', async () => {
    const decision = await checkConnect(
      manifestWith(['*:*']),
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
      manifestWith(['a.example:443', 'b.example:443', '*:*', '10.0.0.1:22']),
      'many.example',
      443,
      resolve
    )
    expect(resolve.calls).toStrictEqual(['many.example'])
  })

  it('resolves the normalised name, so the name checked is the name looked up', async () => {
    const resolve = resolverFor({ 'api.example.com': [PUBLIC_A] })
    const decision = await checkConnect(
      manifestWith(['api.example.com:443']),
      '  API.Example.COM.  ',
      443,
      resolve
    )
    expect(resolve.calls).toStrictEqual(['api.example.com'])
    expect(decision.allowed).toBe(true)
  })

  it('does not resolve an address literal', async () => {
    const resolve = resolverFor({})
    const decision = await checkConnect(manifestWith(['*:*']), PUBLIC_A, 443, resolve)
    expect(decision.allowed).toBe(true)
    expect(resolve.calls).toStrictEqual([])
  })

  it('does not swallow a resolver failure into a denial', async () => {
    // A DNS failure is 'unreachable' with a platformCode -- an attempt the app
    // was permitted to make. Reporting it as 'denied' would strip the errno
    // that honest Node retry logic branches on.
    const failing: Resolver = async () => { throw new Error('ENOTFOUND') }
    await expect(
      checkConnect(manifestWith(['*:*']), 'gone.example', 443, failing)
    ).rejects.toThrow('ENOTFOUND')
  })

  it('does not resolve at all when the capability was never declared', async () => {
    const resolve = resolverFor({ 'api.example.com': [PUBLIC_A] })
    await checkConnect(manifestOf({}), 'api.example.com', 443, resolve)
    expect(resolve.calls).toStrictEqual([])
  })
})

// ---------------------------------------------------------------------------
// 9. Pattern grammar. Every unreadable pattern must remove authority, not
//    grant it.
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
    const decision = await checkConnect(manifestWith([pattern]), 'api.example.com', 443, resolve)
    expect(decision.allowed).toBe(false)
  })

  it('a sub-domain glob matches nothing rather than being approximated', async () => {
    // `*.example.com` looks obviously intended, and that is the danger: the
    // sibling reading, `*.co.uk`, spans a registry boundary. Denying costs the
    // app author seconds; an over-grant the user never sees costs more.
    const decision = await checkConnect(
      manifestWith(['*.example.com:443']),
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
      manifestWith(['*.example.com:443']),
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
      manifestWith(['::1:443']),
      '::1',
      443,
      noResolution
    )
    expect(decision.allowed).toBe(false)
  })

  it('an unreadable pattern does not poison a readable one beside it', async () => {
    const decision = await checkConnect(
      manifestWith(['*.example.com:443', '[::1:80', '*:*']),
      'api.example.com',
      443,
      resolverFor({ 'api.example.com': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 10. Host normalisation, and the arguments an app controls.
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
      manifestWith([pattern]),
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
      manifestWith(['*:*']),
      host,
      443,
      async () => [PUBLIC_A]
    )
    expect(decision.allowed).toBe(false)
  })

  it('the host-length bound is what denies an over-long name, not the resolver', async () => {
    const decision = await checkConnect(
      manifestWith(['*:*']),
      'a'.repeat(300) + '.example',
      443,
      async () => [PUBLIC_A]
    )
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('bad-host')
  })

  it.each([
    { host: 'api.ex\u00e4mple.com', why: 'a Unicode label an app author would write' },
    { host: 'api.ex\u212Aample.com', why: 'U+212A KELVIN SIGN -- toLowerCase folds it to k' }
  ])('denies a non-ASCII host: $why', async ({ host }) => {
    // Fails closed either way, but it used to fail closed SILENTLY and for the
    // wrong reason -- ASCII-only case folding simply never matched. Now it is
    // a deliberate reject with a reason the broker can log.
    const decision = await checkConnect(manifestWith(['*:*']), host, 443, async () => [PUBLIC_A])
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('bad-host')
  })

  it('denies a non-ASCII pattern rather than silently never matching it', async () => {
    const decision = await checkConnect(
      manifestWith(['api.ex\u00e4mple.com:443']),
      'api.ex\u00e4mple.com',
      443,
      async () => [PUBLIC_A]
    )
    expect(decision.allowed).toBe(false)
  })

  it('denies a non-string host without throwing', async () => {
    for (const host of [undefined, null, 42, {}, ['a']]) {
      const decision = await checkConnect(
        manifestWith(['*:*']),
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
        manifestWith([junk, '*:*']),
        junk,
        (next() % 70000) - 2,
        resolverFor({ [junk]: [PUBLIC_A] })
      )
      expect(typeof decision.allowed).toBe('boolean')
    }
  })
})

// ---------------------------------------------------------------------------
// 11. The five mutants the suite missed until 2026-08-27, and the guards
//     added with them. Each test names the wrong implementation it kills.
// ---------------------------------------------------------------------------

describe('host and port must come from the SAME pattern', () => {
  it('MUTANT: denies the cross product of a two-pattern manifest', async () => {
    // The wrong shape is `patterns.some(hostOk) && patterns.some(portOk)`. It
    // reads identically, passed all 143 tests this suite had, and grants
    // a.example:8080 -- a combination the user granted for neither host.
    // The worst of the five, because a multi-pattern manifest is the normal
    // case for any app that is not the flagship.
    const decision = await checkConnect(
      manifestWith(['a.example:443', 'b.example:8080']),
      'a.example',
      8080,
      resolverFor({ 'a.example': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('still allows each pattern on its own terms', async () => {
    // The guard above must not cost the legitimate case: both halves of the
    // same manifest still work at their own declared port.
    const manifest = manifestWith(['a.example:443', 'b.example:8080'])
    const resolve = resolverFor({ 'a.example': [PUBLIC_A], 'b.example': [PUBLIC_B] })
    expect((await checkConnect(manifest, 'a.example', 443, resolve)).allowed).toBe(true)
    expect((await checkConnect(manifest, 'b.example', 8080, resolve)).allowed).toBe(true)
    expect((await checkConnect(manifest, 'b.example', 443, resolve)).allowed).toBe(false)
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
      manifestWith(['a.example:443', '192.168.1.50:8080']),
      'a.example',
      8080,
      resolverFor({ 'a.example': [PUBLIC_A] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('MUTANT: a port range from one pattern does not reach another pattern host', async () => {
    const decision = await checkConnect(
      manifestWith(['tracker.example:6881-6889', 'api.example:443']),
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
      manifestWith(['*:*']),
      'odd.example',
      443,
      (async () => [answer]) as unknown as Resolver
    )
    expect(decision.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 12. Every address that leaves here is a canonical literal. This is the half
//     of the T12 mitigation the file always claimed and did not have.
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
    const decision = await checkConnect(manifestWith(['*:*']), host, 443, noResolution)
    if (decision.allowed) throw new Error(`expected a denial, got ${JSON.stringify(decision.addresses)}`)
    expect(decision.reason).toBe('non-canonical-host')
  })

  it('a non-canonical address is NOT demoted to a hostname', async () => {
    // The dangerous fallthrough: if `2130706433` stopped counting as an
    // address it would be compared as a NAME against a `2130706433` pattern
    // host and match, which is worse than the bug being fixed.
    const decision = await checkConnect(
      manifestWith(['2130706433:22']),
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
    const decision = await checkConnect(manifestWith([pattern]), '127.0.0.1', 22, noResolution)
    expect(decision.allowed).toBe(false)
  })

  it('the readable spelling of the same declaration still works', async () => {
    // The point is legibility, not blocking loopback: an app that says what it
    // means keeps working.
    const decision = await checkConnect(manifestWith(['127.0.0.1:22']), '127.0.0.1', 22, noResolution)
    expect(allowedAddresses(decision)).toStrictEqual(['127.0.0.1'])
  })

  it('denies a resolver answer in a non-canonical encoding', async () => {
    // A real resolver returns canonical forms; this asserts the guarantee is
    // local rather than inherited from that assumption.
    const decision = await checkConnect(
      manifestWith(['*:*']),
      'odd.example',
      443,
      resolverFor({ 'odd.example': ['0x08080808'] })
    )
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('bad-answer')
  })

  it('denies an address carrying a zone id, which is never internet-reachable', async () => {
    const decision = await checkConnect(
      manifestWith(['*:*']),
      'scoped.example',
      443,
      resolverFor({ 'scoped.example': ['2606:4700::1111%eth0'] })
    )
    expect(decision.allowed).toBe(false)
  })

  it('every address of every allow is dialable without a second lookup', async () => {
    const allows = await Promise.all([
      checkConnect(manifestWith(['*:*']), PUBLIC_A, 443, noResolution),
      checkConnect(manifestWith(['*:*']), '[2606:4700::1111]', 443, noResolution),
      checkConnect(manifestWith(['*:*']), 'many.example', 443,
        resolverFor({ 'many.example': ['  93.184.216.34  ', '[2606:4700::1111]', '::ffff:8.8.8.8'] })),
      checkConnect(manifestWith(['127.0.0.1:22']), '127.0.0.1', 22, noResolution)
    ])
    for (const decision of allows) {
      for (const address of allowedAddresses(decision)) {
        expect(looksDialable(address), `${address} would be re-resolved by a dialer`).toBe(true)
      }
    }
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
    const decision = await checkConnect(manifestWith(['api.example.com:443']), 'printer.lan', 22, resolve)
    expect(resolve.calls).toStrictEqual([])
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('no-pattern-possible')
  })

  it('does not resolve a name no hostname pattern names', async () => {
    const resolve = resolverFor({ 'gitlab.internal.corp': [PUBLIC_A] })
    await checkConnect(manifestWith(['api.example.com:443']), 'gitlab.internal.corp', 443, resolve)
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
    const manifest = manifestWith(['api.example.com:443'])
    const exists = await checkConnect(manifest, 'exists.lan', 22, resolve)
    const absent = await checkConnect(manifest, 'absent.lan', 22, resolve)
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
    const decision = await checkConnect(manifestWith(['*:*']), 'anything.example', 443, resolve)
    expect(resolve.calls).toStrictEqual(['anything.example'])
    expect(decision.allowed).toBe(false)
  })

  it('STILL resolves when an address-literal pattern is declared', async () => {
    // nas.internal -> 192.168.1.50 is the legitimate case the literal branch
    // exists for, and it cannot be ruled out from the name alone.
    const resolve = resolverFor({ 'nas.internal': ['192.168.1.50'] })
    const decision = await checkConnect(manifestWith(['192.168.1.50:5000']), 'nas.internal', 5000, resolve)
    expect(resolve.calls).toStrictEqual(['nas.internal'])
    expect(allowedAddresses(decision)).toStrictEqual(['192.168.1.50'])
  })
})

// ---------------------------------------------------------------------------
// 14. Counts are bounded, and the result is safe to hold.
// ---------------------------------------------------------------------------

describe('bounds and result hygiene', () => {
  it('denies a manifest with more patterns than the bound', async () => {
    // Item LENGTHS were bounded; item COUNTS were not, and the work is their
    // product. Measured before the bound: 20000 patterns x 1000 answers took
    // 13.9 SECONDS of synchronous CPU on the broker's UI thread (T11b).
    const many = Array.from({ length: 257 }, (_, i) => `h${i}.example:443`)
    const decision = await checkConnect(manifestOf({ net: { tcp: { connect: many } } }), PUBLIC_A, 443, noResolution)
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('too-many-patterns')
  })

  it('denies a resolver answer set larger than the bound', async () => {
    const many = Array.from({ length: 65 }, (_, i) => `93.184.0.${i}`)
    const decision = await checkConnect(manifestWith(['*:*']), 'many.example', 443, async () => many)
    if (decision.allowed) throw new Error('expected a denial')
    expect(decision.reason).toBe('too-many-answers')
  })

  it('a realistic manifest and answer set stay well inside the bounds', async () => {
    const decision = await checkConnect(
      manifestWith(['*:6881-6889', 'tracker.example:443']),
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
      manifestWith(['*:*']),
      'dup.example',
      443,
      resolverFor({ 'dup.example': [PUBLIC_A, PUBLIC_A, '  93.184.216.34  ', PUBLIC_B] })
    )
    expect(allowedAddresses(decision)).toStrictEqual([PUBLIC_A, PUBLIC_B])
  })

  it('the allow cannot be edited between the decision and the dial', async () => {
    // The gap between deciding and dialling is the only place a validated set
    // can be changed, and nothing downstream re-checks it.
    const decision = await checkConnect(manifestWith(['*:*']), PUBLIC_A, 443, noResolution)
    if (!decision.allowed) throw new Error('expected an allow')
    expect(Object.isFrozen(decision)).toBe(true)
    expect(Object.isFrozen(decision.addresses)).toBe(true)
    expect(() => { (decision.addresses as string[]).push('127.0.0.1') }).toThrow()
    expect(decision.addresses).toStrictEqual([PUBLIC_A])
  })
})
