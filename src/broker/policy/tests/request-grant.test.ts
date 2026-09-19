import { describe, expect, it } from 'vitest'
import { decideGrantRequest, isCapabilityKind } from '../request-grant.js'
import type { Manifest } from '../../../contracts/index.js'

// app.requestGrant's own security shape (queue item 4.1): "resolves false if
// declined OR NOT DECLARED" -- this suite is the "not declared" half, and
// the half that proves a grant can never exceed the manifest, which never
// gets to a person at all if it fails here. Security-critical the same way
// update.test.ts's decideUpdate suite is: the failure mode is silence, a
// widened grant nobody would notice by using the product.

function manifestWith (capabilities: Manifest['capabilities']): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version: '1.0.0', entry: 'index.html', capabilities }
}

describe('decideGrantRequest', () => {
  it('refuses a capability the manifest never declares at all', () => {
    const manifest = manifestWith({})
    const decision = decideGrantRequest(manifest, 'tcp.connect', ['api.example.com:443'])
    expect(decision).toEqual({ allowed: false, patterns: [] })
  })

  it('allows a request for exactly what the manifest declares', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })
    const decision = decideGrantRequest(manifest, 'tcp.connect', ['api.example.com:443'])
    expect(decision).toEqual({ allowed: true, patterns: ['api.example.com:443'] })
  })

  it('allows a request narrower than what the manifest declares, granting only what was asked', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] } } })
    const decision = decideGrantRequest(manifest, 'tcp.connect', ['api.example.com:443'])
    expect(decision).toEqual({ allowed: true, patterns: ['api.example.com:443'] })
  })

  // The exact failure mode the exit criterion names: "requesting a WIDER
  // pattern than declared must not silently widen the grant". A caller that
  // clamped this down to the declared set instead of refusing would still
  // be safe, but refusing is the stricter, unambiguous choice -- an app
  // asking for more than its own manifest promised is already behaving
  // outside its declared contract, and this is not this policy's call to
  // paper over silently.
  it('refuses a request wider than what the manifest declares, creating nothing', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })
    const decision = decideGrantRequest(manifest, 'tcp.connect', ['*:*'])
    expect(decision).toEqual({ allowed: false, patterns: [] })
  })

  it('refuses a request naming an address outside every declared pattern', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })
    const decision = decideGrantRequest(manifest, 'tcp.connect', ['evil.example:443'])
    expect(decision).toEqual({ allowed: false, patterns: [] })
  })

  it('defaults to the full declared pattern set when the request carries none', () => {
    const manifest = manifestWith({ net: { tcp: { listen: ['6881-6889'] } } })
    const decision = decideGrantRequest(manifest, 'tcp.listen', undefined)
    expect(decision).toEqual({ allowed: true, patterns: ['6881-6889'] })
  })

  it('allows a declared https.connect request (the mapping this change fixed)', () => {
    const manifest = manifestWith({ net: { https: { connect: ['api.example.com:443'] } } })
    const decision = decideGrantRequest(manifest, 'https.connect', ['api.example.com:443'])
    expect(decision).toEqual({ allowed: true, patterns: ['api.example.com:443'] })
  })

  it('never lets an https.connect request ride on a tcp.connect declaration -- separate grants (ADR-0017)', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] } } })
    const decision = decideGrantRequest(manifest, 'https.connect', ['api.example.com:443'])
    expect(decision).toEqual({ allowed: false, patterns: [] })
  })

  it('allows fs when declared, with no patterns either way -- carries none (manifest.ts FsCapability)', () => {
    const manifest = manifestWith({ fs: { quotaBytes: 1024 } })
    const decision = decideGrantRequest(manifest, 'fs', undefined)
    expect(decision).toEqual({ allowed: true, patterns: [] })
  })

  it('refuses fs when the manifest never declares it', () => {
    const manifest = manifestWith({})
    const decision = decideGrantRequest(manifest, 'fs', undefined)
    expect(decision).toEqual({ allowed: false, patterns: [] })
  })

  it('allows id when declared', () => {
    const manifest = manifestWith({ id: { curves: ['secp256k1'] } })
    const decision = decideGrantRequest(manifest, 'id', undefined)
    expect(decision).toEqual({ allowed: true, patterns: [] })
  })

  it('refuses id when the manifest never declares it', () => {
    const manifest = manifestWith({})
    const decision = decideGrantRequest(manifest, 'id', undefined)
    expect(decision).toEqual({ allowed: false, patterns: [] })
  })
})

// R2-01, Half 2: a REQUEST must never be able to carry a host:port pattern
// shape a MANIFEST could never have declared in the first place. Before
// this fix, `widensAuthority`'s subset check used the runtime's own looser
// matching grammar (connect-patterns.ts's `covers`), under which a
// manifest declaring "*:*" appears to "cover" a request for "*:443" -- a
// shape `declarableConnectHostRejection` (connect-patterns.ts) refuses
// outright, because the only host-wildcard a manifest may declare directly
// is the exact literal "*:*". Half 1 (grant-prompt-render.test.ts) is what
// this would have looked like to a person approving it, had it reached a
// prompt at all; this suite is the half that keeps it from reaching one.
describe('decideGrantRequest -- a request may never declare a shape the manifest grammar itself would refuse', () => {
  it('refuses "*:443" under a "*:*" manifest -- a shape no manifest could ever declare directly', () => {
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })
    const decision = decideGrantRequest(manifest, 'https.connect', ['*:443'])
    expect(decision).toEqual({ allowed: false, patterns: [] })
  })

  it('still allows a genuinely narrower named-host request under the same "*:*" manifest -- narrowing is the feature, not over-corrected away', () => {
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })
    const decision = decideGrantRequest(manifest, 'https.connect', ['youtube.com:443'])
    expect(decision).toEqual({ allowed: true, patterns: ['youtube.com:443'] })
  })

  it('still allows the manifest\'s own "*:*" pattern requested back exactly as declared', () => {
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })
    const decision = decideGrantRequest(manifest, 'https.connect', ['*:*'])
    expect(decision).toEqual({ allowed: true, patterns: ['*:*'] })
  })

  it('applies the same refusal to tcp.connect and udp.send, not only https.connect', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] }, udp: { send: ['*:*'] } } })
    expect(decideGrantRequest(manifest, 'tcp.connect', ['*:22'])).toEqual({ allowed: false, patterns: [] })
    expect(decideGrantRequest(manifest, 'udp.send', ['*:53'])).toEqual({ allowed: false, patterns: [] })
  })

  it('does not touch tcp.listen/udp.bind -- bare port ranges have no host and no equivalent gap', () => {
    const manifest = manifestWith({ net: { tcp: { listen: ['6881-6889'] } } })
    const decision = decideGrantRequest(manifest, 'tcp.listen', ['6881-6889'])
    expect(decision).toEqual({ allowed: true, patterns: ['6881-6889'] })
  })

  // web.context gets NO special refusal here -- ADR-0019, spec item 6's
  // "declared-in-the-manifest-only" rule belongs in main/request-grant.ts's
  // own requestGrant (the actual app.requestGrant entry point), not here:
  // this function is also grant-persistence.ts's hydrateGrants's own
  // "does a restored grant still fit the current manifest" check and
  // main/grant-changed-capabilities.ts's install-consent grant call, and a
  // blanket refusal here would have silently broken both -- a persisted
  // web.context grant never surviving a restart, and install consent never
  // being able to grant one at all. So web.context behaves exactly like
  // every other capability from this function's own point of view.
  it('allows web.context for exactly what the manifest declares, same as any other capability', () => {
    const manifest = manifestWith({ web: { contexts: ['https://example.com'] } })
    const decision = decideGrantRequest(manifest, 'web.context', ['https://example.com'])
    expect(decision).toEqual({ allowed: true, patterns: ['https://example.com'] })
  })

  it('allows web.context with no requested patterns at all -- "whatever is declared"', () => {
    const manifest = manifestWith({ web: { contexts: ['https://example.com'] } })
    const decision = decideGrantRequest(manifest, 'web.context', undefined)
    expect(decision).toEqual({ allowed: true, patterns: ['https://example.com'] })
  })

  it('refuses web.context when the manifest never declares it', () => {
    const manifest = manifestWith({})
    const decision = decideGrantRequest(manifest, 'web.context', ['https://example.com'])
    expect(decision).toEqual({ allowed: false, patterns: [] })
  })

  it('refuses a web.context request naming an origin outside what the manifest declared', () => {
    const manifest = manifestWith({ web: { contexts: ['https://example.com'] } })
    const decision = decideGrantRequest(manifest, 'web.context', ['https://evil.example'])
    expect(decision).toEqual({ allowed: false, patterns: [] })
  })
})

// Shared by main/request-grant.ts (an app's raw IPC payload) and
// grants/grant-persistence.ts (a JSON property name read off disk) -- both
// need the same "is this untrusted string one of the eight real
// CapabilityKind literals" check, moved here so a third copy is never
// tempting.
describe('isCapabilityKind', () => {
  it.each(['tcp.connect', 'tcp.listen', 'udp.bind', 'udp.send', 'https.connect', 'fs', 'id', 'web.context'])(
    'accepts %s',
    (kind) => { expect(isCapabilityKind(kind)).toBe(true) }
  )

  it.each(['net.connect', 'TCP.CONNECT', '', 'tcp.connect ', 'websocket'])(
    'refuses %j',
    (value) => { expect(isCapabilityKind(value)).toBe(false) }
  )

  // isCapabilityKind must recognise web.context (for persistence and the
  // permissions panel, buildPersistedAppPermissions's own isCapabilityKind
  // filter) even though decideGrantRequest refuses it unconditionally above
  // -- the two are DIFFERENT questions ("is this a real capability kind" vs
  // "may app.requestGrant mint one"), and conflating them would have made
  // a persisted web.context grant vanish on restore.
  it('accepting web.context here is independent of decideGrantRequest refusing it', () => {
    expect(isCapabilityKind('web.context')).toBe(true)
  })
})
