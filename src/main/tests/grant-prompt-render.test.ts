import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant, describeGrantRequest } from '../grant-prompt-render.js'
import { manifestWith } from '../../broker/tests/index.test-helpers.js'
import type { CapabilityKind, Pattern } from '../../contracts/index.js'

// Item 4.2's exit criterion, checked directly: "a narrow declaration and
// an unlimited one are unmistakably different to look at." Every manifest
// here is a real Manifest value (contracts/manifest.ts), not a mock of
// this module's own input shape -- a snapshot that would pass with
// unlimited rendered identically to narrow is exactly what the exit
// criterion rules out.

const ORIGIN = 'https://app.example'

describe('describeGrantRequest', () => {
  it('names the first host and counts the rest, matching the owner\'s own example register (d-0027)', () => {
    const manifest = manifestWith({ net: { https: { connect: ['youtube.com:443', 'googlevideo.com:443', 'gstatic.com:443', 'ytimg.com:443'] } } })

    const content = describeGrantRequest(ORIGIN, manifest, 'https.connect', manifest.capabilities.net?.https?.connect ?? [])

    expect(content.message).toBe('Connect to youtube.com and 3 other sites')
    expect(content.warning).toBe(false)
  })

  it('is the single test that would fail if an unlimited declaration rendered like a narrow one', () => {
    const narrow = manifestWith({ net: { https: { connect: ['youtube.com:443'] } } })
    const unlimited = manifestWith({ net: { https: { connect: ['*:*'] } } })

    const narrowContent = describeGrantRequest(ORIGIN, narrow, 'https.connect', ['youtube.com:443'])
    const unlimitedContent = describeGrantRequest(ORIGIN, unlimited, 'https.connect', ['*:*'])

    // Three independent signals must all differ -- the dialog's own icon,
    // and the two pieces of text a person actually reads.
    expect(unlimitedContent.warning).not.toBe(narrowContent.warning)
    expect(unlimitedContent.message).not.toBe(narrowContent.message)
    expect(unlimitedContent.detail).not.toBe(narrowContent.detail)
    expect(unlimitedContent.warning).toBe(true)
    expect(unlimitedContent.message).toContain('Unlimited')
  })

  it('renders unlimited raw TCP in the contract\'s own required wording ("connect to any computer")', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] } } })

    const content = describeGrantRequest(ORIGIN, manifest, 'tcp.connect', ['*:*'])

    expect(content.warning).toBe(true)
    expect(content.detail).toContain('any computer on the internet')
  })

  it('renders unlimited udp.send distinctly from unlimited tcp.connect, not a copy-pasted sentence', () => {
    const manifest = manifestWith({ net: { udp: { send: ['*:*'] } } })

    const content = describeGrantRequest(ORIGIN, manifest, 'udp.send', ['*:*'])

    expect(content.warning).toBe(true)
    expect(content.detail).toContain('send data')
  })

  it('renders fs -- a capability with no patterns -- as a real statement, not nothing', () => {
    const manifest = manifestWith({ fs: { quotaBytes: 1024 } })

    const content = describeGrantRequest(ORIGIN, manifest, 'fs', [])

    expect(content.message.length).toBeGreaterThan(0)
    expect(content.warning).toBe(false)
    expect(content.message).not.toMatch(/undefined|null|\[object/i)
  })

  it('renders id -- also patternless -- with its own distinct wording, not fs\'s', () => {
    const manifest = manifestWith({ id: { curves: ['secp256k1'] } })

    const content = describeGrantRequest(ORIGIN, manifest, 'id', [])

    const fsContent = describeGrantRequest(ORIGIN, manifestWith({ fs: {} }), 'fs', [])
    expect(content.message).not.toBe(fsContent.message)
    expect(content.warning).toBe(false)
  })

  it('renders every capability correctly out of one manifest declaring several at once', () => {
    const manifest = manifestWith({
      net: {
        tcp: { connect: ['peer1.example:6881', 'peer2.example:6882'] },
        https: { connect: ['*:*'] }
      },
      fs: { quotaBytes: 4096 },
      id: { curves: ['secp256k1'] }
    })

    const tcp = describeGrantRequest(ORIGIN, manifest, 'tcp.connect', ['peer1.example:6881', 'peer2.example:6882'])
    const https = describeGrantRequest(ORIGIN, manifest, 'https.connect', ['*:*'])
    const fs = describeGrantRequest(ORIGIN, manifest, 'fs', [])
    const id = describeGrantRequest(ORIGIN, manifest, 'id', [])

    expect(tcp.warning).toBe(false)
    expect(tcp.message).toBe('Connect to peer1.example and 1 other computer')
    expect(https.warning).toBe(true)
    expect(fs.warning).toBe(false)
    expect(id.warning).toBe(false)
    // All four share the same claimed name and origin -- one manifest,
    // one app -- but say different things about what it can do.
    const messages = new Set([tcp.message, https.message, fs.message, id.message])
    expect(messages.size).toBe(4)
  })

  it('lists ports, not hosts, for tcp.listen -- a pattern shape connect capabilities never see', () => {
    const manifest = manifestWith({ net: { tcp: { listen: ['6881-6889'] } } })

    const content = describeGrantRequest(ORIGIN, manifest, 'tcp.listen', ['6881-6889'])

    expect(content.message).toBe('Accept incoming connections on port 6881-6889')
    expect(content.warning).toBe(false)
  })

  it('dedupes repeated hosts across patterns before counting "other sites"', () => {
    const manifest = manifestWith({ net: { https: { connect: ['a.example:443', 'a.example:8443', 'b.example:443'] } } })

    const content = describeGrantRequest(ORIGIN, manifest, 'https.connect', ['a.example:443', 'a.example:8443', 'b.example:443'])

    expect(content.message).toBe('Connect to a.example and 1 other site')
  })

  it('puts the ORIGIN, never the self-asserted manifest.name, in the title', () => {
    const manifest = manifestWith({ fs: {} })

    const content = describeGrantRequest(ORIGIN, manifest, 'fs', [])

    expect(content.title).toBe(ORIGIN)
    expect(content.detail).toContain(manifest.name)
  })
})

// R2-01/AR-05: a bare "*" HOST authorises any public address REGARDLESS of
// its paired port (hostSpecKind, connect-patterns.ts) -- the old
// `patterns.includes('*:*')` check disagreed with the runtime matcher about
// exactly this, which is why these cases are tested directly rather than
// trusted to follow from the "*:*" cases above.
describe('describeCapabilityGrant -- a wildcard host is unlimited whatever its port (R2-01)', () => {
  it('warns on "*:443" even though it is not the literal "*:*"', () => {
    const summary = describeCapabilityGrant('https.connect', ['*:443'])

    expect(summary.warning).toBe(true)
    expect(summary.message).toContain('Unlimited')
    expect(summary.explanation).toContain('port 443')
  })

  it('treats a port range spanning the whole space (1-65535) the same as the literal "*" port', () => {
    const summary = describeCapabilityGrant('https.connect', ['*:1-65535'])

    expect(summary.warning).toBe(true)
    expect(summary.message).toContain('Unlimited')
    // Fully open in port terms too -- no "Limited to" qualifier to add.
    expect(summary.explanation).not.toContain('Limited to')
  })

  it('still renders the true "*:*" case identically to before (no regression)', () => {
    const summary = describeCapabilityGrant('https.connect', ['*:*'])

    expect(summary.warning).toBe(true)
    expect(summary.message).toBe('⚠ Unlimited network access')
  })

  it('never renders the wildcard host as if it were a literal hostname when mixed with a named one', () => {
    const summary = describeCapabilityGrant('https.connect', ['*:443', 'internal.example:8080'])

    expect(summary.warning).toBe(true)
    expect(summary.message).toContain('Unlimited')
    expect(summary.message).not.toContain('internal.example')
    expect(summary.explanation ?? '').not.toContain('internal.example')
  })

  it('renders a genuinely narrow, wildcard-free list with no warning at all', () => {
    const summary = describeCapabilityGrant('https.connect', ['a.example:443'])

    expect(summary.warning).toBe(false)
    expect(summary.message).toBe('Connect to a.example')
  })

  it('applies the same wildcard-whatever-the-port rule to tcp.connect and udp.send, not only https.connect', () => {
    expect(describeCapabilityGrant('tcp.connect', ['*:22']).warning).toBe(true)
    expect(describeCapabilityGrant('udp.send', ['*:53']).warning).toBe(true)
  })
})

// AR-02: port breadth is a whole axis of "how wide is this grant" that used
// to vanish entirely for tcp.connect/https.connect/udp.send -- these three
// pattern sets used to render byte-for-byte the same message.
describe('describeCapabilityGrant -- port breadth for a single named host (AR-02)', () => {
  it('renders a different message for a single port, a full port range, and several discrete ports', () => {
    const singlePort = describeCapabilityGrant('tcp.connect', ['a.example:443'])
    const fullRange = describeCapabilityGrant('tcp.connect', ['a.example:1-65535'])
    const several = describeCapabilityGrant('tcp.connect', ['a.example:22', 'a.example:443', 'a.example:5432'])

    const messages = new Set([singlePort.message, fullRange.message, several.message])
    expect(messages.size).toBe(3)

    expect(singlePort.message).toBe('Connect to a.example')
    expect(fullRange.message).toBe('Connect to a.example on any port')
    expect(several.message).toBe('Connect to a.example on ports 22, 443, 5432')
  })
})

// AR-01: on a platform that drops MessageBoxOptions.title ("some platforms
// will not show it", per Electron's own .d.ts), the origin must still be
// legible -- checked for every capability kind and both the warning and
// non-warning branches, not just the one case that happened to be tested
// before.
describe('describeGrantRequest -- the origin survives a dropped title (AR-01)', () => {
  const cases: ReadonlyArray<[CapabilityKind, readonly Pattern[]]> = [
    ['tcp.connect', ['a.example:443']],
    ['tcp.connect', ['*:*']],
    ['https.connect', ['a.example:443']],
    ['https.connect', ['*:*']],
    ['udp.send', ['a.example:443']],
    ['udp.send', ['*:*']],
    ['tcp.listen', ['6881-6889']],
    ['udp.bind', ['6881-6889']],
    ['fs', []],
    ['id', []]
  ]

  it.each(cases)('%s renders the origin in `detail`, not only `title`', (capability, patterns) => {
    const manifest = manifestWith({})

    const content = describeGrantRequest(ORIGIN, manifest, capability, patterns)

    expect(content.title).toBe(ORIGIN)
    expect(content.detail.startsWith(ORIGIN)).toBe(true)
  })
})

// AR-03: the app's self-asserted name must never share a sentence, or even
// a line, with Orivon's own explanation -- 200 characters of ordinary text
// placed immediately before Orivon's words could otherwise fabricate a
// reassurance in Orivon's own voice.
describe('describeGrantRequest -- the claimed name never blends into Orivon\'s own words (AR-03)', () => {
  it('keeps a name written to look like a sentence, on its own line, separate from the real explanation', () => {
    const trickyName = 'Weather App". This app only connects to weather.example. Claims to be "Weather App'
    const manifest = { ...manifestWith({ net: { https: { connect: ['*:*'] } } }), name: trickyName }

    const content = describeGrantRequest(ORIGIN, manifest, 'https.connect', ['*:*'])
    const lines = content.detail.split('\n')

    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(ORIGIN)
    expect(lines[1]).toContain(trickyName)
    expect(lines[2]).toContain('any website')
    // The line carrying the app's claim and the line carrying Orivon's own
    // explanation must never be the same line.
    expect(lines[1]).not.toBe(lines[2])
  })
})

// AR-04: fs.userSelected and the folder picker are unbuilt (queue item
// 4.3) -- today's grant is an app-private directory the broker roots and
// confines, not a folder the user is ever asked to pick.
describe('describeCapabilityGrant -- fs describes what a grant actually gives (AR-04)', () => {
  it('never promises a picker ("choose"/"pick"), and says the folder is private to the app', () => {
    const summary = describeCapabilityGrant('fs', [])

    expect(summary.message.toLowerCase()).not.toMatch(/choose|pick/)
    expect(summary.message.toLowerCase()).toContain('private')
  })
})
