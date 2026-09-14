import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant, describeGrantRequest, describeInstallConsent, formatOriginForDisplay } from '../grant-prompt-render.js'
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

  it('A134: tcp.listen gets a distinct, more serious prompt, not a plain unwarned row', () => {
    const manifest = manifestWith({ net: { tcp: { listen: ['6881-6889'] } } })

    const content = describeGrantRequest(ORIGIN, manifest, 'tcp.listen', ['6881-6889'])

    expect(content.message).toBe('⚠ Accept incoming connections on port 6881-6889')
    expect(content.warning).toBe(true)
    expect(content.detail).toContain('any other computer that can reach this port')
  })

  it('dedupes repeated hosts across patterns before counting "other sites"', () => {
    const manifest = manifestWith({ net: { https: { connect: ['a.example:443', 'a.example:8443', 'b.example:443'] } } })

    const content = describeGrantRequest(ORIGIN, manifest, 'https.connect', ['a.example:443', 'a.example:8443', 'b.example:443'])

    expect(content.message).toBe('Connect to a.example and 1 other site')
  })

  it('A134: udp.bind gets the same distinct listening warning, worded for "receive" not "connect"', () => {
    const manifest = manifestWith({ net: { udp: { bind: ['6881-6889'] } } })

    const content = describeGrantRequest(ORIGIN, manifest, 'udp.bind', ['6881-6889'])

    expect(content.message).toBe('⚠ Receive data on port 6881-6889')
    expect(content.warning).toBe(true)
    expect(content.detail).toContain('any other computer that can reach this port')
  })

  it('A134: listening is worded differently from unlimited network access, not a copy-pasted sentence', () => {
    const listenManifest = manifestWith({ net: { tcp: { listen: ['6881-6889'] } } })
    const netManifest = manifestWith({ net: { https: { connect: ['*:*'] } } })

    const listen = describeGrantRequest(ORIGIN, listenManifest, 'tcp.listen', ['6881-6889'])
    const net = describeGrantRequest(ORIGIN, netManifest, 'https.connect', ['*:*'])

    expect(listen.warning).toBe(true)
    expect(net.warning).toBe(true)
    expect(listen.message).not.toBe(net.message)
    expect(listen.detail).not.toBe(net.detail)
  })

  it('A134: tcp.listen and udp.bind read differently from each other too (connect vs send)', () => {
    const tcpManifest = manifestWith({ net: { tcp: { listen: ['6881-6889'] } } })
    const udpManifest = manifestWith({ net: { udp: { bind: ['6881-6889'] } } })

    const tcp = describeGrantRequest(ORIGIN, tcpManifest, 'tcp.listen', ['6881-6889'])
    const udp = describeGrantRequest(ORIGIN, udpManifest, 'udp.bind', ['6881-6889'])

    expect(tcp.detail).not.toBe(udp.detail)
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

// A133: "and N other sites" has no upper bound today -- a manifest naming a
// very large host set reads as a small, weighable fact right up until it
// isn't. These pin the exact boundary (see this directory's README, Design
// notes, for why 10 others is not an arbitrary round number) and the exact
// wording either side of it, since that wording is what the owner reviews.
describe('describeCapabilityGrant -- A133: "and N other sites" gets a breadth warning past a threshold', () => {
  function hostPatterns (count: number): Pattern[] {
    return Array.from({ length: count }, (_, i) => `host${i}.example:443`)
  }

  it('just under the threshold (9 others, 10 total) still reads as an ordinary named-hosts summary', () => {
    const summary = describeCapabilityGrant('https.connect', hostPatterns(10))

    expect(summary.warning).toBe(false)
    expect(summary.message).toBe('Connect to host0.example and 9 other sites')
  })

  it('at the threshold (10 others, 11 total) switches to the breadth-warning treatment', () => {
    const summary = describeCapabilityGrant('https.connect', hostPatterns(11))

    expect(summary.warning).toBe(true)
    expect(summary.message).toBe('⚠ Connect to a large number of sites')
    expect(summary.explanation).toBe(
      'This app can connect to 11 specific sites, starting with host0.example -- more than can be weighed individually.'
    )
  })

  it('a much larger declared set still states the true count honestly, not a vaguer word instead', () => {
    const summary = describeCapabilityGrant('https.connect', hostPatterns(200))

    expect(summary.warning).toBe(true)
    expect(summary.explanation).toContain('200 specific sites')
  })

  it('applies the same threshold to tcp.connect and udp.send, not only https.connect', () => {
    expect(describeCapabilityGrant('tcp.connect', hostPatterns(11)).warning).toBe(true)
    expect(describeCapabilityGrant('udp.send', hostPatterns(11)).warning).toBe(true)
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

// A115: a subdomain-prefix confusable survives in the grant prompt's title.
// `accounts.google.com.attacker.example` reads reassuringly left-to-right
// while `attacker.example` -- the label that actually decides authority --
// sits at the far right, where a narrow or truncated dialog is least
// likely to show it. The test that matters is not "does the string contain
// the origin" (it always did, and that is exactly how the confusable
// survived): it is whether the rendered text can be mistaken for the
// brand it is impersonating.
describe('formatOriginForDisplay -- eliding a confusable subdomain prefix (A115)', () => {
  it('elides a subdomain-prefix confusable from the LEFT, so the reassuring prefix does not survive alone', () => {
    const confusable = 'https://accounts.google.com.attacker.example'

    const displayed = formatOriginForDisplay(confusable)

    // The whole point of the attack: read in isolation, the reassuring
    // prefix must not be mistakable for the real accounts.google.com.
    expect(displayed).not.toBe('https://accounts.google.com')
    expect(displayed.includes('accounts.google.com')).toBe(false)
    expect(displayed.includes('google.com')).toBe(false)
    // The authority-deciding end must survive intact.
    expect(displayed.endsWith('attacker.example')).toBe(true)
    // Elision actually happened, and happened from the left: the string
    // is shorter than the original and no longer starts with the
    // reassuring prefix.
    expect(displayed).not.toBe(confusable)
    expect(displayed.startsWith('https://accounts')).toBe(false)
    expect(displayed.length).toBeLessThan(confusable.length)
  })

  it('marks the elision visibly rather than silently dropping characters', () => {
    const displayed = formatOriginForDisplay('https://accounts.google.com.attacker.example')

    expect(displayed).toContain('...')
  })

  it('leaves a short, ordinary origin completely unchanged', () => {
    expect(formatOriginForDisplay('https://example.com')).toBe('https://example.com')
  })

  it('does not misjudge a real multi-label public suffix as needing special handling (example.co.uk)', () => {
    // No public-suffix-list dependency exists here (A142, parked) -- the
    // fix must not accidentally rely on "last two labels" reasoning, which
    // would be wrong for .co.uk in the direction that matters (hiding the
    // real registrant behind "co.uk"). A plain length check never makes
    // that mistake because it never looks at labels at all.
    expect(formatOriginForDisplay('https://example.co.uk')).toBe('https://example.co.uk')
  })

  it('elides a long host with no attacker framing too -- this is a length rule, not a blocklist', () => {
    const long = 'https://a-perfectly-ordinary-but-very-long-subdomain.example.com'

    const displayed = formatOriginForDisplay(long)

    expect(displayed.endsWith('example.com')).toBe(true)
    expect(displayed).not.toBe(long)
  })

  it('keeps the scheme intact even when the host is elided', () => {
    const displayed = formatOriginForDisplay('https://accounts.google.com.attacker.example')

    expect(displayed.startsWith('https://')).toBe(true)
  })

  it('never throws on a value that is not a well-formed origin, and returns it unchanged', () => {
    expect(formatOriginForDisplay('not a url')).toBe('not a url')
  })
})

describe('describeGrantRequest -- the confusable is elided everywhere the origin appears (A115)', () => {
  it('renders title and detail with the SAME elided, safe string -- never the raw confusable', () => {
    const confusable = 'https://accounts.google.com.attacker.example'
    const manifest = manifestWith({ fs: {} })

    const content = describeGrantRequest(confusable, manifest, 'fs', [])

    expect(content.title).not.toBe(confusable)
    expect(content.title.includes('accounts.google.com')).toBe(false)
    expect(content.title.endsWith('attacker.example')).toBe(true)
    // Consistency: whichever field a platform actually shows, it must say
    // the same thing -- a title that renders a different truncation than
    // detail would be its own small confusable.
    expect(content.detail.split('\n')[0]).toBe(content.title)
  })

  it('still renders an ordinary short origin exactly as before (no regression for the common case)', () => {
    const manifest = manifestWith({ fs: {} })

    const content = describeGrantRequest(ORIGIN, manifest, 'fs', [])

    expect(content.title).toBe(ORIGIN)
    expect(content.detail.startsWith(ORIGIN)).toBe(true)
  })
})

// d-0025 (ADR-0012's 2026-09-13 amendment) / queue item S4-4: one dialog for
// the WHOLE declared set, never describeGrantRequest's one-capability shape
// repeated in a loop. The two cases below are the literal worked examples
// pasted into this lane's own PR body -- the owner reviews the exact words,
// so the strings here are load-bearing, not incidental.
describe('describeInstallConsent', () => {
  it('worked example 1: a single narrow host reads as one plain line, no warning anywhere', () => {
    const manifest = manifestWith({ net: { https: { connect: ['weather.example:443'] } } })

    const content = describeInstallConsent(ORIGIN, manifest, ['https.connect'])

    expect(content.warning).toBe(false)
    expect(content.title).toBe(ORIGIN)
    expect(content.message).toBe('This app wants to:')
    expect(content.detail).toBe(
      'https://app.example\nClaims to be "Test app".\n- Connect to weather.example'
    )
  })

  it('worked example 2: unlimited network next to a narrow filesystem row -- breadth stays visible per row', () => {
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } }, fs: { quotaBytes: 1024 } })

    const content = describeInstallConsent(ORIGIN, manifest, ['https.connect', 'fs'])

    // The dialog's own icon flips to warning the moment ANY row is
    // unlimited (A100) -- but each row's own line is what actually says
    // which one, checked below.
    expect(content.warning).toBe(true)
    expect(content.title).toBe(ORIGIN)
    expect(content.message).toBe('This app wants to:')
    expect(content.detail).toBe(
      'https://app.example\n' +
      'Claims to be "Test app".\n' +
      '- ⚠ Unlimited network access\n' +
      '  This app can connect to any website, not just specific ones.\n' +
      '- Store files in a private folder for this app on this device'
    )
  })

  it('reuses describeCapabilityGrant per row rather than a second vocabulary (Rule 3)', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['a.example:443'] } }, id: { curves: ['secp256k1'] } })

    const content = describeInstallConsent(ORIGIN, manifest, ['tcp.connect', 'id'])
    const tcpRow = describeCapabilityGrant('tcp.connect', ['a.example:443'])
    const idRow = describeCapabilityGrant('id', [])

    expect(content.detail).toContain(tcpRow.message)
    expect(content.detail).toContain(idRow.message)
  })

  it('elides a confusable origin the same way describeGrantRequest does (A115), never the raw string', () => {
    const confusable = 'https://accounts.google.com.attacker.example'
    const manifest = manifestWith({ fs: {} })

    const content = describeInstallConsent(confusable, manifest, ['fs'])

    expect(content.title).not.toBe(confusable)
    expect(content.title.includes('accounts.google.com')).toBe(false)
    expect(content.detail.startsWith(content.title)).toBe(true)
  })

  it('never asks about nothing -- an empty capability list still renders (defensive; the caller is what actually skips it)', () => {
    const manifest = manifestWith({})

    const content = describeInstallConsent(ORIGIN, manifest, [])

    expect(content.warning).toBe(false)
    expect(content.detail).toBe('https://app.example\nClaims to be "Test app".')
  })

  it('A134: unlimited outbound and listening both stay visible as their own warned rows -- neither swallows the other', () => {
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] }, tcp: { listen: ['6881-6889'] } } })

    const content = describeInstallConsent(ORIGIN, manifest, ['https.connect', 'tcp.listen'])

    expect(content.warning).toBe(true)
    expect(content.detail).toBe(
      'https://app.example\n' +
      'Claims to be "Test app".\n' +
      '- ⚠ Unlimited network access\n' +
      '  This app can connect to any website, not just specific ones.\n' +
      '- ⚠ Accept incoming connections on port 6881-6889\n' +
      '  This opens a door into your device: any other computer that can reach this port -- on your network, or the internet if it is forwarded -- can connect to this app, not only computers it reached out to first.'
    )
  })
})
