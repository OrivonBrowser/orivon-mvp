import { describe, expect, it } from 'vitest'
import type { Manifest } from '../../../contracts/index.js'
import { checkConnect } from '../connect.js'
import { checkConnectSecure } from '../connect-secure.js'
import { declarableConnectHostRejection, isDeclarableConnectPattern } from '../connect-patterns.js'
import { decideGrantRequest } from '../request-grant.js'
import { decideUpdate, widensAuthority } from '../update.js'
import type { PatternSet, UpdateInput } from '../update.js'
import { PUBLIC_A, noResolution, resolverFor } from './connect.test-helpers.js'

// A wildcard host paired with a port or a port range, for tcp.connect and
// https.connect. Everything here goes through the same entry points the broker
// uses: the declarable check, checkConnect, checkConnectSecure and the update
// subset check. A reserved port (A82) is reached only by a pattern that names
// it exactly. The wildcard host never reaches a private, loopback or
// link-local address literal, whatever its port; for https.connect a public
// NAME that resolves to one is not caught, because checkConnectSecure never
// resolves (A245).

const PRIVATE_LITERALS = ['127.0.0.1', '192.168.1.1', '10.0.0.5', '169.254.169.254', '::1']

describe('the declarable grammar: a wildcard host with a port', () => {
  it.each(['tcp.connect', 'https.connect'] as const)('accepts "*:6697" and "*:lo-hi" for %s', (kind) => {
    expect(declarableConnectHostRejection('*', '*:6697', kind)).toBeNull()
    expect(declarableConnectHostRejection('*', '*:6660-6699', kind)).toBeNull()
    expect(declarableConnectHostRejection('*', '*:*', kind)).toBeNull()
  })

  it('keeps udp.send at "*:*" only, so A304 stays the owner\'s to decide', () => {
    expect(declarableConnectHostRejection('*', '*:*', 'udp.send')).toBeNull()
    expect(declarableConnectHostRejection('*', '*:53', 'udp.send')).toBe('wildcard-needs-wildcard-port')
    expect(declarableConnectHostRejection('*', '*:1-65535', 'udp.send')).toBe('wildcard-needs-wildcard-port')
  })

  it('still refuses a sub-glob host for every kind', () => {
    for (const kind of ['tcp.connect', 'https.connect', 'udp.send'] as const) {
      expect(declarableConnectHostRejection('*.example.com', '*.example.com:6697', kind)).toBe('sub-glob')
    }
  })

  it('isDeclarableConnectPattern follows the same grammar per kind, and still checks the port', () => {
    expect(isDeclarableConnectPattern('*:6697', 'tcp.connect')).toBe(true)
    expect(isDeclarableConnectPattern('*:6660-6699', 'https.connect')).toBe(true)
    expect(isDeclarableConnectPattern('*:6697', 'udp.send')).toBe(false)
    expect(isDeclarableConnectPattern('*:*', 'udp.send')).toBe(true)
    expect(isDeclarableConnectPattern('*:0', 'tcp.connect')).toBe(false)
    expect(isDeclarableConnectPattern('*:70000', 'tcp.connect')).toBe(false)
    expect(isDeclarableConnectPattern('*:9-1', 'tcp.connect')).toBe(false)
  })
})

describe('checkConnect with a wildcard host and a port', () => {
  it('"*:6697" reaches irc.example.org and any public address at 6697', async () => {
    const resolve = resolverFor({ 'irc.example.org': [PUBLIC_A] })
    const byName = await checkConnect(['*:6697'], 'irc.example.org', 6697, resolve)
    expect(byName).toEqual({ allowed: true, addresses: [PUBLIC_A] })
    const byAddress = await checkConnect(['*:6697'], PUBLIC_A, 6697, noResolution)
    expect(byAddress.allowed).toBe(true)
  })

  it.each(PRIVATE_LITERALS)('"*:6697" does not reach %s at 6697', async (host) => {
    expect((await checkConnect(['*:6697'], host, 6697, noResolution)).allowed).toBe(false)
  })

  it('"*:6697" does not reach a name that resolves to a private address', async () => {
    const resolve = resolverFor({ 'irc.evil.example': ['192.168.1.1'] })
    expect((await checkConnect(['*:6697'], 'irc.evil.example', 6697, resolve)).allowed).toBe(false)
  })

  it('"*:*" alone still refuses 6697 and 6667', async () => {
    expect(await checkConnect(['*:*'], PUBLIC_A, 6697, noResolution)).toMatchObject({ allowed: false, reason: 'reserved-port' })
    expect(await checkConnect(['*:*'], PUBLIC_A, 6667, noResolution)).toMatchObject({ allowed: false, reason: 'reserved-port' })
  })

  it('"*:6660-6699" refuses 6667 and 6697 but allows 6668', async () => {
    const range = ['*:6660-6699']
    expect((await checkConnect(range, PUBLIC_A, 6667, noResolution)).allowed).toBe(false)
    expect((await checkConnect(range, PUBLIC_A, 6697, noResolution)).allowed).toBe(false)
    expect((await checkConnect(range, PUBLIC_A, 6668, noResolution)).allowed).toBe(true)
  })

  it('"*:6697" does not allow 6698', async () => {
    expect((await checkConnect(['*:6697'], PUBLIC_A, 6698, noResolution)).allowed).toBe(false)
  })

  it('a mixed list ["*:*", "*:6697"] allows 6697 and 7000 and still refuses 6667', async () => {
    const mixed = ['*:*', '*:6697']
    expect((await checkConnect(mixed, PUBLIC_A, 6697, noResolution)).allowed).toBe(true)
    expect((await checkConnect(mixed, PUBLIC_A, 7000, noResolution)).allowed).toBe(true)
    expect((await checkConnect(mixed, PUBLIC_A, 6667, noResolution)).allowed).toBe(false)
  })
})

describe('checkConnectSecure with a wildcard host and a port', () => {
  it('"*:6697" allows irc.example.org and any public address at 6697', () => {
    expect(checkConnectSecure(['*:6697'], 'irc.example.org', 6697)).toEqual({ allowed: true, host: 'irc.example.org' })
    expect(checkConnectSecure(['*:6697'], PUBLIC_A, 6697)).toEqual({ allowed: true, host: PUBLIC_A })
  })

  it.each(PRIVATE_LITERALS)('"*:6697" does not reach %s at 6697', (host) => {
    expect(checkConnectSecure(['*:6697'], host, 6697).allowed).toBe(false)
  })

  it('"*:*" alone still refuses 6697', () => {
    expect(checkConnectSecure(['*:*'], 'irc.example.org', 6697)).toMatchObject({ allowed: false, reason: 'reserved-port' })
  })

  // A245: checkConnectSecure never resolves, so the address gate above sees an
  // address literal only. A public-looking name that resolves to a LAN address
  // passes here; a certificate binds the name, not the address.
  it('decides by the requested name alone, so a name that would resolve to the LAN is not caught (A245)', () => {
    expect(checkConnectSecure(['*:443'], 'plex-192-168-1-5.example.direct', 443)).toEqual({
      allowed: true,
      host: 'plex-192-168-1-5.example.direct'
    })
    expect(checkConnectSecure(['*:443'], '192.168.1.5', 443).allowed).toBe(false)
  })

  it('"*:6660-6699" refuses 6667 and 6697 but allows 6668', () => {
    expect(checkConnectSecure(['*:6660-6699'], 'irc.example.org', 6667).allowed).toBe(false)
    expect(checkConnectSecure(['*:6660-6699'], 'irc.example.org', 6697).allowed).toBe(false)
    expect(checkConnectSecure(['*:6660-6699'], 'irc.example.org', 6668).allowed).toBe(true)
  })

  it('"*:6697" does not allow 6698', () => {
    expect(checkConnectSecure(['*:6697'], 'irc.example.org', 6698).allowed).toBe(false)
  })

  it('a mixed list ["*:*", "*:6697"] allows 6697 and 7000 and still refuses 6667', () => {
    const mixed = ['*:*', '*:6697']
    expect(checkConnectSecure(mixed, 'irc.example.org', 6697).allowed).toBe(true)
    expect(checkConnectSecure(mixed, 'irc.example.org', 7000).allowed).toBe(true)
    expect(checkConnectSecure(mixed, 'irc.example.org', 6667).allowed).toBe(false)
  })
})

describe('an update that adds a wildcard host with a port', () => {
  const PINNED = 'a'.repeat(64)
  function updateTo (granted: readonly string[], declared: readonly string[]): UpdateInput {
    return {
      pinnedHash: PINNED,
      newHash: PINNED,
      grantedPatterns: { 'tcp.connect': granted },
      newPatterns: { 'tcp.connect': declared },
      version: '1.2.0',
      versionFloor: '1.2.0',
      rollbackAcknowledged: false
    }
  }
  const widens = (granted: readonly string[], requested: readonly string[]): boolean =>
    widensAuthority({ 'tcp.connect': granted } satisfies PatternSet, { 'tcp.connect': requested })

  it('adding "*:6697" to a manifest that had "*:*" widens reach and re-prompts', () => {
    // "*:*" never reaches 6697; "*:6697" does, so this is new authority even
    // though every port of "*:6697" lies inside "*:*".
    expect(widens(['*:*'], ['*:*', '*:6697'])).toBe(true)
    expect(decideUpdate(updateTo(['*:*'], ['*:*', '*:6697']))).toBe('capability-prompt')
  })

  it('a named host at a reserved port widens a "*:*" grant too, for the same reason', () => {
    expect(widens(['*:*'], ['irc.example.org:6697'])).toBe(true)
  })

  it('"*:443" is a subset of "*:*", so it stays silent', () => {
    expect(widens(['*:*'], ['*:443'])).toBe(false)
    expect(decideUpdate(updateTo(['*:*'], ['*:443']))).toBe('silent')
  })

  it('"*:6697" is not a subset of "*:6660-6699"', () => {
    expect(widens(['*:6660-6699'], ['*:6697'])).toBe(true)
  })

  it('"*:6697" stays covered by the same "*:6697", and by a grant naming the same port for that host', () => {
    expect(widens(['*:6697'], ['*:6697'])).toBe(false)
    expect(widens(['*:6697'], ['irc.example.org:6697'])).toBe(false)
  })

  it('"*:6697" is not covered by a host pattern, and "*:*" covers a named host on an ordinary port', () => {
    expect(widens(['irc.example.org:6697'], ['*:6697'])).toBe(true)
    expect(widens(['*:*'], ['irc.example.org:6668'])).toBe(false)
  })

  it('a reserved port named inside a range is not a naming, so a range grant does not cover the exact one', () => {
    expect(widens(['irc.example.org:6660-6699'], ['irc.example.org:6697'])).toBe(true)
  })
})

describe('coverage by a wildcard host reaches only what the wildcard reaches at run time', () => {
  const widens = (granted: readonly string[], requested: readonly string[]): boolean =>
    widensAuthority({ 'tcp.connect': granted } satisfies PatternSet, { 'tcp.connect': requested })

  it.each(['10.0.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '[::1]', 'localhost', 'app.localhost'])(
    '"*:*" does not cover %s, so naming it is a widening',
    (host) => {
      expect(widens(['*:*'], [`${host}:80`])).toBe(true)
      expect(widens(['*:*'], ['*:*', `${host}:80`])).toBe(true)
    }
  )

  it('"*:6697" does not cover a private literal at 6697', () => {
    expect(widens(['*:6697'], ['10.0.0.1:6697'])).toBe(true)
  })

  it('still covers a public literal, a public name and the wildcard itself', () => {
    expect(widens(['*:*'], ['8.8.8.8:443'])).toBe(false)
    expect(widens(['*:*'], ['api.example.com:443'])).toBe(false)
    expect(widens(['*:*'], ['*:443'])).toBe(false)
    expect(widens(['*:443'], ['*:443'])).toBe(false)
  })

  it('a private literal already granted stays covered by itself', () => {
    expect(widens(['192.168.1.1:80'], ['192.168.1.1:80'])).toBe(false)
    expect(widens(['*:*', '192.168.1.1:80'], ['192.168.1.1:80'])).toBe(false)
  })

  it('a bracketed wildcard is one shape for coverage and for run time', () => {
    expect(widens(['*:443'], ['[*]:443'])).toBe(false)
    expect(widens(['api.example.com:443'], ['[*]:443'])).toBe(true)
  })

  it('a request under a wildcard manifest may not name a private literal or a localhost name', () => {
    const manifest: Manifest = {
      orivonApiVersion: 0,
      id: 'app.test',
      name: 'Test',
      version: '1.0.0',
      entry: 'index.html',
      capabilities: { net: { tcp: { connect: ['*:6697'] }, https: { connect: ['*:*'] } } }
    }
    const ask = (kind: 'tcp.connect' | 'https.connect', patterns: string[]) => decideGrantRequest(manifest, kind, patterns)
    expect(ask('tcp.connect', ['10.0.0.1:6697'])).toEqual({ allowed: false, patterns: [] })
    expect(ask('https.connect', ['localhost:3000'])).toEqual({ allowed: false, patterns: [] })
    expect(ask('https.connect', ['192.168.1.1:443'])).toEqual({ allowed: false, patterns: [] })
    expect(ask('https.connect', ['api.example.com:443'])).toEqual({ allowed: true, patterns: ['api.example.com:443'] })
  })
})

describe('a bracketed wildcard host', () => {
  it.each(['tcp.connect', 'https.connect', 'udp.send'] as const)('is never declarable for %s', (kind) => {
    expect(isDeclarableConnectPattern('[*]:443', kind)).toBe(false)
    expect(isDeclarableConnectPattern('[*]:*', kind)).toBe(false)
  })

  it('an unknown kind fails closed', () => {
    expect(declarableConnectHostRejection('*', '*:*', 'udp.bind' as never)).not.toBeNull()
  })
})
