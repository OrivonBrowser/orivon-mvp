import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant, describeCapabilityPrompt, describeGrantRequest, describeInstallConsent, describeReconsent, describeRollbackChoice, formatOriginForDisplay } from '../grant-prompt-render.js'
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

// A133, CORRECTED: the first threshold (10 OTHER hosts, a single-digit vs
// double-digit reading of English) was proven wrong by a real counter-
// example -- a 12-host feed reader tripped it, and twelve individually
// named feeds is a narrow declaration by any sensible reading, not a
// breadth risk. Re-anchored on MAX_PATTERNS (the real, enforced ceiling on
// how many hosts one capability's array may ever declare): the warning now
// fires only past HALF that ceiling. The feed reader is the regression
// test that must never trip again; see this directory's README, Design
// notes, for the full before/after.
describe('describeCapabilityGrant -- A133: "and N other sites" gets a breadth warning past a threshold', () => {
  function hostPatterns (count: number): Pattern[] {
    return Array.from({ length: count }, (_, i) => `host${i}.example:443`)
  }

  it('REGRESSION: a 12-feed reader -- the case that broke the original threshold -- never warns', () => {
    const feeds = ['nytimes.com:443', 'bbc.com:443', 'reuters.com:443', 'apnews.com:443', 'npr.org:443', 'theguardian.com:443', 'wsj.com:443', 'ft.com:443', 'economist.com:443', 'aljazeera.com:443', 'dw.com:443', 'lemonde.fr:443']
    const summary = describeCapabilityGrant('https.connect', feeds)

    expect(summary.warning).toBe(false)
    expect(summary.message).toBe('Connect to nytimes.com and 11 other sites')
  })

  it('just under the threshold (127 hosts) still reads as an ordinary named-hosts summary', () => {
    const summary = describeCapabilityGrant('https.connect', hostPatterns(127))

    expect(summary.warning).toBe(false)
    expect(summary.message).toBe('Connect to host0.example and 126 other sites')
  })

  it('at the threshold (128 hosts -- half of MAX_PATTERNS) switches to the breadth-warning treatment', () => {
    const summary = describeCapabilityGrant('https.connect', hostPatterns(128))

    expect(summary.warning).toBe(true)
    expect(summary.message).toBe('⚠ Connect to a large number of sites')
    expect(summary.explanation).toBe(
      'This app can connect to 128 specific sites, starting with host0.example -- more than can be weighed individually.'
    )
  })

  it('a much larger declared set still states the true count honestly, not a vaguer word instead', () => {
    const summary = describeCapabilityGrant('https.connect', hostPatterns(200))

    expect(summary.warning).toBe(true)
    expect(summary.explanation).toContain('200 specific sites')
  })

  it('applies the same threshold to tcp.connect and udp.send, not only https.connect', () => {
    expect(describeCapabilityGrant('tcp.connect', hostPatterns(128)).warning).toBe(true)
    expect(describeCapabilityGrant('udp.send', hostPatterns(128)).warning).toBe(true)
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
// before. Owner decision, 2026-09-14: the origin is the LAST line of
// `detail`, not the first -- it is the one field a scam app cannot fake,
// so it belongs where a hurried reader's eye lands right before the
// buttons, not buried under the app's own self-asserted name.
describe('describeGrantRequest -- the origin survives a dropped title (AR-01), now as the last line', () => {
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

  it.each(cases)('%s renders the origin in `detail`, not only `title`, as the LAST line', (capability, patterns) => {
    const manifest = manifestWith({})

    const content = describeGrantRequest(ORIGIN, manifest, capability, patterns)

    expect(content.title).toBe(ORIGIN)
    expect(content.detail.endsWith(ORIGIN)).toBe(true)
  })
})

// AR-03: the app's self-asserted name must never share a sentence, or even
// a line, with Orivon's own explanation -- 200 characters of ordinary text
// placed immediately before Orivon's words could otherwise fabricate a
// reassurance in Orivon's own voice.
describe('describeGrantRequest -- the claimed name never blends into Orivon\'s own words (AR-03)', () => {
  it('keeps a name written to look like a sentence, on its own line, separate from the real explanation and from the address', () => {
    const trickyName = 'Weather App". This app only connects to weather.example. Claims to be "Weather App'
    const manifest = { ...manifestWith({ net: { https: { connect: ['*:*'] } } }), name: trickyName }

    const content = describeGrantRequest(ORIGIN, manifest, 'https.connect', ['*:*'])
    const lines = content.detail.split('\n')

    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain(trickyName)
    expect(lines[1]).toContain('any website')
    expect(lines[2]).toBe(ORIGIN)
    // The line carrying the app's claim and the line carrying Orivon's own
    // explanation must never be the same line.
    expect(lines[0]).not.toBe(lines[1])
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
describe('formatOriginForDisplay -- the last three labels, owner decision 2026-09-14 (A115/A142)', () => {
  it('elides a subdomain-prefix confusable to exactly its last three labels, so the reassuring prefix does not survive alone', () => {
    const confusable = 'https://accounts.google.com.attacker.example'

    const displayed = formatOriginForDisplay(confusable)

    // The whole point of the attack: read in isolation, the reassuring
    // prefix must not be mistakable for the real accounts.google.com.
    expect(displayed).not.toBe('https://accounts.google.com')
    expect(displayed.includes('accounts.google.com')).toBe(false)
    expect(displayed.includes('google.com')).toBe(false)
    // The owner's own worked example, verbatim.
    expect(displayed).toBe('https://...com.attacker.example')
  })

  it('marks the elision visibly rather than silently dropping labels', () => {
    const displayed = formatOriginForDisplay('https://accounts.google.com.attacker.example')

    expect(displayed).toContain('...')
  })

  it('leaves a short, ordinary origin completely unchanged', () => {
    expect(formatOriginForDisplay('https://example.com')).toBe('https://example.com')
  })

  it('shows the whole host at exactly three labels -- the owner\'s own "www, google, com" example', () => {
    expect(formatOriginForDisplay('https://www.google.com')).toBe('https://www.google.com')
  })

  it('gets example.co.uk right BY CONSTRUCTION, with no public-suffix-list dependency (A142)', () => {
    // example.co.uk is exactly three labels -- the whole host, unelided.
    // A naive "last two labels" rule would show "co.uk" and hide the real
    // registrant; counting labels instead of guessing at suffix shape never
    // makes that mistake.
    expect(formatOriginForDisplay('https://example.co.uk')).toBe('https://example.co.uk')
  })

  it('drops only "www" from a four-label .co.uk host, still showing the true registrant', () => {
    expect(formatOriginForDisplay('https://www.example.co.uk')).toBe('https://...example.co.uk')
  })

  it('a long but exactly-three-label host is shown in full -- this is a label-count rule, not a length rule', () => {
    // The old character-count rule elided this host (67 characters); the
    // owner's rule does not look at length at all, only label count.
    const long = 'https://a-perfectly-ordinary-but-very-long-subdomain.example.com'

    expect(formatOriginForDisplay(long)).toBe(long)
  })

  it('keeps the scheme intact even when the host is elided', () => {
    const displayed = formatOriginForDisplay('https://accounts.google.com.attacker.example')

    expect(displayed.startsWith('https://')).toBe(true)
  })

  it('never throws on a value that is not a well-formed origin, and returns it unchanged', () => {
    expect(formatOriginForDisplay('not a url')).toBe('not a url')
  })

  describe('an IP literal is never chopped -- it is not label-structured, and cutting it changes which machine it names', () => {
    it('a bare IPv4 literal survives whole, even though a naive label-split would produce four "labels"', () => {
      expect(formatOriginForDisplay('http://203.0.113.10')).toBe('http://203.0.113.10')
    })

    it('an IPv6 literal in brackets survives whole', () => {
      expect(formatOriginForDisplay('https://[2001:db8::1]')).toBe('https://[2001:db8::1]')
    })

    it('an IPv6 literal keeps its port too', () => {
      expect(formatOriginForDisplay('https://[2001:db8::1]:8443')).toBe('https://[2001:db8::1]:8443')
    })
  })

  it('localhost -- a single label -- survives whole', () => {
    expect(formatOriginForDisplay('https://localhost')).toBe('https://localhost')
    expect(formatOriginForDisplay('https://localhost:8080')).toBe('https://localhost:8080')
  })

  it('a non-default port belongs to the host and survives an elision intact', () => {
    // Under the old character-count rule this port's own digits ate into
    // the elision budget and swallowed the "com" label too
    // (https://...attacker.example:8443) -- the port is no longer part of
    // what gets counted or cut.
    const displayed = formatOriginForDisplay('https://accounts.google.com.attacker.example:8443')

    expect(displayed).toBe('https://...com.attacker.example:8443')
  })

  it('an already-punycoded IDN host is passed through untouched when it has three or fewer labels, never re-encoded', () => {
    expect(formatOriginForDisplay('https://xn--e1aybc.xn--p1ai')).toBe('https://xn--e1aybc.xn--p1ai')
    expect(formatOriginForDisplay('https://www.xn--e1aybc.xn--p1ai')).toBe('https://www.xn--e1aybc.xn--p1ai')
  })

  it('an already-punycoded IDN host past three labels is elided the same way, still never re-encoded', () => {
    expect(formatOriginForDisplay('https://a.b.xn--e1aybc.xn--p1ai')).toBe('https://...b.xn--e1aybc.xn--p1ai')
  })

  it('a trailing dot (an explicit FQDN root) is not itself counted as a label', () => {
    // Four real labels plus a root dot must still elide, same as without
    // the dot -- and the elided form drops the dot along with the rest,
    // the same way it already drops "www".
    expect(formatOriginForDisplay('https://accounts.google.com.attacker.example.')).toBe('https://...com.attacker.example')
    // Three or fewer real labels plus a root dot must still show the
    // whole (unchanged) origin, dot included.
    expect(formatOriginForDisplay('https://example.com.')).toBe('https://example.com.')
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
    // detail would be its own small confusable. The origin is the LAST
    // line of `detail` (owner decision 2026-09-14), not the first.
    const lines = content.detail.split('\n')
    expect(lines[lines.length - 1]).toBe(content.title)
  })

  it('still renders an ordinary short origin exactly as before (no regression for the common case)', () => {
    const manifest = manifestWith({ fs: {} })

    const content = describeGrantRequest(ORIGIN, manifest, 'fs', [])

    expect(content.title).toBe(ORIGIN)
    expect(content.detail.endsWith(ORIGIN)).toBe(true)
  })
})

// d-0025 (ADR-0012's 2026-09-13 amendment) / queue item S4-4: one dialog for
// the WHOLE declared set, never describeGrantRequest's one-capability shape
// repeated in a loop. The two cases below are the literal worked examples
// pasted into this lane's own PR body -- the owner reviews the exact words,
// so the strings here are load-bearing, not incidental.
//
// Owner decision, 2026-09-14: the address moves to the LAST line of
// `detail`, after the capability rows -- the one thing in this dialog a
// scam app cannot fake belongs where a hurried reader's eye lands right
// before the buttons, not directly under the app's own claimed name.
describe('describeInstallConsent', () => {
  it('worked example 1: a single narrow host reads as one plain line, no warning anywhere', () => {
    const manifest = manifestWith({ net: { https: { connect: ['weather.example:443'] } } })

    const content = describeInstallConsent(ORIGIN, manifest, ['https.connect'])

    expect(content.warning).toBe(false)
    expect(content.title).toBe(ORIGIN)
    expect(content.message).toBe('This app wants to:')
    expect(content.detail).toBe(
      'Claims to be "Test app".\n- Connect to weather.example\nhttps://app.example'
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
      'Claims to be "Test app".\n' +
      '- ⚠ Unlimited network access\n' +
      '  This app can connect to any website, not just specific ones.\n' +
      '- Store files in a private folder for this app on this device\n' +
      'https://app.example'
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
    expect(content.detail.endsWith(content.title)).toBe(true)
  })

  it('never asks about nothing -- an empty capability list still renders (defensive; the caller is what actually skips it)', () => {
    const manifest = manifestWith({})

    const content = describeInstallConsent(ORIGIN, manifest, [])

    expect(content.warning).toBe(false)
    expect(content.detail).toBe('Claims to be "Test app".\nhttps://app.example')
  })

  it('A134: unlimited outbound and listening both stay visible as their own warned rows -- neither swallows the other', () => {
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] }, tcp: { listen: ['6881-6889'] } } })

    const content = describeInstallConsent(ORIGIN, manifest, ['https.connect', 'tcp.listen'])

    expect(content.warning).toBe(true)
    expect(content.detail).toBe(
      'Claims to be "Test app".\n' +
      '- ⚠ Unlimited network access\n' +
      '  This app can connect to any website, not just specific ones.\n' +
      '- ⚠ Accept incoming connections on port 6881-6889\n' +
      '  This opens a door into your device: any other computer that can reach this port -- on your network, or the internet if it is forwarded -- can connect to this app, not only computers it reached out to first.\n' +
      'https://app.example'
    )
  })

  // Coordinator review, 2026-09-14: the round above did not test what
  // happens when SEVERAL warned capabilities appear together, and the
  // flagship's real manifest broke it -- 4 of 5 rows warned, one headline
  // ("⚠ Unlimited network access") appearing twice from tcp.connect and
  // udp.send. These pin the two merges that fix it.
  it('merges tcp.connect and udp.send into ONE row when both are unlimited -- an identical headline never repeats', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] }, udp: { send: ['*:*'] } } })

    const content = describeInstallConsent(ORIGIN, manifest, ['tcp.connect', 'udp.send'])

    expect(content.warning).toBe(true)
    expect(content.detail).toBe(
      'Claims to be "Test app".\n' +
      '- ⚠ Unlimited network access\n' +
      '  This app can connect to any computer on the internet, not just specific ones. This app can send data to any computer on the internet, not just specific ones.\n' +
      'https://app.example'
    )
  })

  it('merges tcp.listen and udp.bind into ONE row on the same ports, not two "opens a door" rows', () => {
    const manifest = manifestWith({ net: { tcp: { listen: ['6881-6889'] }, udp: { bind: ['6881-6889'] } } })

    const content = describeInstallConsent(ORIGIN, manifest, ['tcp.listen', 'udp.bind'])

    expect(content.warning).toBe(true)
    expect(content.detail).toBe(
      'Claims to be "Test app".\n' +
      '- ⚠ Accepts connections and data from other computers on port 6881-6889\n' +
      '  This opens a door into your device: any other computer that can reach these ports -- on your network, or the internet if they are forwarded -- can connect to or send data to this app, not only computers this app contacted first.\n' +
      'https://app.example'
    )
  })

  it('a listen/bind merge on DIFFERENT port ranges still names both, not one range silently standing in for the other', () => {
    const manifest = manifestWith({ net: { tcp: { listen: ['6881-6889'] }, udp: { bind: ['6969'] } } })

    const content = describeInstallConsent(ORIGIN, manifest, ['tcp.listen', 'udp.bind'])

    expect(content.detail).toContain('⚠ Accepts connections and data from other computers on port 6881-6889 (TCP) and port 6969 (UDP)')
  })

  it('does NOT merge tcp.listen alone with anything -- the merge needs both capabilities present, not just one warned row', () => {
    const manifest = manifestWith({ net: { tcp: { listen: ['6881-6889'] } } })

    const content = describeInstallConsent(ORIGIN, manifest, ['tcp.listen'])

    expect(content.detail).toContain('⚠ Accept incoming connections on port 6881-6889')
    expect(content.detail).not.toContain('Accepts connections and data from other computers')
  })

  it('THE FLAGSHIP: connect *:*, listen, udp.bind and udp.send *:* together render exactly two warnings, not four, and no repeated headline', () => {
    const manifest = manifestWith({
      net: {
        tcp: { connect: ['*:*'], listen: ['6881-6889'] },
        udp: { bind: ['6881-6889'], send: ['*:*'] }
      },
      fs: { quotaBytes: 1024 * 1024 * 1024 }
    })

    const content = describeInstallConsent(ORIGIN, manifest, ['tcp.connect', 'tcp.listen', 'udp.bind', 'udp.send', 'fs'])

    expect(content.warning).toBe(true)
    expect(content.detail).toBe(
      'Claims to be "Test app".\n' +
      '- ⚠ Unlimited network access\n' +
      '  This app can connect to any computer on the internet, not just specific ones. This app can send data to any computer on the internet, not just specific ones.\n' +
      '- ⚠ Accepts connections and data from other computers on port 6881-6889\n' +
      '  This opens a door into your device: any other computer that can reach these ports -- on your network, or the internet if they are forwarded -- can connect to or send data to this app, not only computers this app contacted first.\n' +
      '- Store files in a private folder for this app on this device\n' +
      'https://app.example'
    )
    // Five declared capabilities collapse to three rows: two distinct kinds
    // of breadth (outbound reach, inbound reach), never a fourth repeating
    // one of the first two.
    expect(content.detail.match(/\n- /g)).toHaveLength(3)
    expect(content.detail.match(/⚠/g)).toHaveLength(2)
  })
})

// Owner decision, 2026-09-14: every dialog that shows an origin moves it to
// the LAST line of `detail`, not only describeInstallConsent -- the update
// prompts (describeCapabilityPrompt, describeReconsent, describeRollbackChoice)
// share describeCapabilityGrant's per-row rendering already (Rule 3); these
// three checks are what confirms they also share the new address position,
// not just the install prompt this lane's PR body leads with.
describe('describeCapabilityPrompt -- shares describeInstallConsent\'s row rendering and address-last order', () => {
  it('renders the claim, then the row, then the address last', () => {
    const manifest = manifestWith({ fs: {} })

    const content = describeCapabilityPrompt(ORIGIN, manifest, { fs: [] })

    expect(content.title).toBe(ORIGIN)
    expect(content.message).toBe('This app wants to do more than you already allowed:')
    expect(content.detail).toBe(
      'Claims to be "Test app".\n' +
      '- Store files in a private folder for this app on this device\n' +
      'https://app.example'
    )
  })
})

describe('describeReconsent -- the claim and notice come first, the address last', () => {
  it('renders exactly this order (owner decision 2026-09-14)', () => {
    const manifest = manifestWith({ fs: {} })

    const content = describeReconsent(ORIGIN, manifest)

    expect(content.title).toBe(ORIGIN)
    expect(content.message).toBe('This app has been updated.')
    expect(content.detail).toBe(
      'Claims to be "Test app".\n' +
      'Its code has changed. What it is allowed to do has not.\n' +
      'https://app.example'
    )
  })
})

describe('describeRollbackChoice -- the claim and both notices come first, the address last', () => {
  it('renders exactly this order (owner decision 2026-09-14)', () => {
    const manifest = manifestWith({ fs: {} })

    const content = describeRollbackChoice(ORIGIN, manifest, '2.0.0')

    expect(content.title).toBe(ORIGIN)
    expect(content.message).toBe('This app is offering an older version.')
    expect(content.detail).toBe(
      'Claims to be "Test app".\n' +
      "You've used version 2.0.0 or newer from this app before. It is now offering version 1.0.0 -- an older one.\n" +
      'This can be a genuine rollback by the developer, or a sign that something is serving old, less secure code.\n' +
      'https://app.example'
    )
  })
})
