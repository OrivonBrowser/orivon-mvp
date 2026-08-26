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
// ONE MUTATION SURVIVES, and it is recorded rather than hidden: deleting the
// `classifyAddress(address) === 'unparseable'` guard in checkConnect changes
// no result. Every branch beneath it already rejects an unparseable answer --
// isPrivateAddress is true for anything it cannot parse (./address.ts), and
// the literal branch compares strings, so a parseable pattern host can never
// equal an unparseable address.
//
// That is an argument, so it was checked rather than trusted: both versions
// were run over a grid of 187,109 (pattern set x host x resolver answer x
// port) combinations, weighted towards answers address.ts cannot parse, and
// the two decision streams came back byte-identical. No input distinguishes
// the guard, so no test here can. It is kept as defence in depth for the day
// ./address.ts stops failing closed, and named here because claiming the suite
// covers it would be the more comfortable lie.

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

describe('the denial is uniform', () => {
  it('carries a code and nothing else', async () => {
    const decision = await checkConnect(
      manifestWith(['*:*']),
      'evil.example',
      443,
      resolverFor({ 'evil.example': ['127.0.0.1'] })
    )
    expect(decision).toStrictEqual({ allowed: false, code: 'denied' })
    expect(Object.keys(decision).sort()).toStrictEqual(['allowed', 'code'])
    expect('platformCode' in decision).toBe(false)
    expect('reason' in decision).toBe(false)
  })

  it('is byte-identical whatever the reason was', async () => {
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
      expect(result).toStrictEqual(results[0])
    }
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
    const decision = await checkConnect(
      manifestWith(['*:*']),
      host,
      443,
      resolverFor({})
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
