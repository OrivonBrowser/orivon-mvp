import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant, describeInstallConsent } from '../grant-prompt-render.js'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'
import type { Pattern } from '../../../contracts/index.js'
import { RESERVED_PORTS } from '../../../broker/policy/reserved-ports.js'

// Split out of grant-prompt-render.test.ts (Rule 2, line budget) along the
// same seam grant-prompt-connect.ts itself was split on: everything about
// turning a HOST:PORT PATTERN LIST into a sentence, tested through the one
// public entry point both files share, `describeCapabilityGrant`.

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
    // The named host is on a port the wildcard does not reach, so it is said.
    expect(summary.explanation).toContain('It can also reach internal.example on port 8080.')
    expect(summary.explanation).not.toContain('*')
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

  // A single named host with dozens of discrete ports is capped the same way
  // every other per-item row list in this file is (decision 10), rather than
  // listing every one on the same line.
  it('caps a long list of discrete ports for a single host, folding the rest into a count', () => {
    const patterns = Array.from({ length: 60 }, (_, i) => `a.example:${String(i + 1)}`)
    const summary = describeCapabilityGrant('tcp.connect', patterns)

    expect(summary.message).toContain('ports 1, 2, 3')
    expect(summary.message).toMatch(/and 40 more/)
  })
})

// A197: a manifest pattern naming a loopback/private/link-local address is
// the ONLY way that address becomes reachable at all (hostMatches,
// connect-patterns.ts: a hostname never authorises one, even its own) --
// so it is never a cosmetic detail. Before this fix, `namedHostsSummary`
// folded it into "and N other sites" exactly like an ordinary public host,
// and even a SOLE private address rendered with no warning and no class
// stated at all. A person can reasonably skim `api.example.com`; they
// cannot skim "your own device" or "a computer on your network" the same
// way, so this must never be summarised into a count (the owner's own
// framing of the finding).
describe('describeCapabilityGrant -- A197: a private/loopback/link-local address is never folded into a count', () => {
  it('REGRESSION: the exact defect -- a loopback address sitting third is swallowed whole by "and N other sites"', () => {
    const summary = describeCapabilityGrant('https.connect', ['api.example.com:443', 'cdn.example.com:443', '127.0.0.1:9000'])

    expect(summary.message).toContain('127.0.0.1')
    expect(summary.warning).toBe(true)
  })

  it('names a sole loopback address and states plainly what it is, rather than a bare, unwarned "Connect to 127.0.0.1"', () => {
    const summary = describeCapabilityGrant('https.connect', ['127.0.0.1:9000'])

    expect(summary.warning).toBe(true)
    expect(summary.message).toContain('127.0.0.1')
    expect(summary.explanation).toContain('your own device')
  })

  it('names a private RFC 1918 address and calls it a computer on the local network, not a website', () => {
    const summary = describeCapabilityGrant('https.connect', ['192.168.1.1:443'])

    expect(summary.warning).toBe(true)
    expect(summary.message).toContain('192.168.1.1')
    expect(summary.explanation).toContain('your local network')
  })

  it('names the link-local cloud-metadata address specifically, not just a generic "private" label', () => {
    const summary = describeCapabilityGrant('tcp.connect', ['169.254.169.254:80'])

    expect(summary.warning).toBe(true)
    expect(summary.message).toContain('169.254.169.254')
  })

  it('names every sensitive address when a manifest declares several at once, not just the first', () => {
    const summary = describeCapabilityGrant('https.connect', ['127.0.0.1:9000', '192.168.1.1:443'])

    expect(summary.message).toContain('127.0.0.1')
    expect(summary.message).toContain('192.168.1.1')
  })

  it('still folds ordinary PUBLIC named hosts into a count once a sensitive address is present, rather than listing all of them too', () => {
    const summary = describeCapabilityGrant('https.connect', ['api.example.com:443', 'cdn.example.com:443', 'other.example:443', '127.0.0.1:9000'])

    expect(summary.message).toContain('127.0.0.1')
    expect(summary.message).toMatch(/\d+ other site/)
  })

  it('leaves an ordinary, address-free named-hosts summary completely unaffected (no regression)', () => {
    const summary = describeCapabilityGrant('https.connect', ['api.example.com:443', 'cdn.example.com:443'])

    expect(summary.warning).toBe(false)
    expect(summary.message).toBe('Connect to api.example.com and 1 other site')
  })

  it('a PUBLIC IP literal is not treated as sensitive -- only non-public address space is (T12\'s own boundary)', () => {
    const summary = describeCapabilityGrant('tcp.connect', ['93.184.216.34:443'])

    expect(summary.warning).toBe(false)
    expect(summary.message).toBe('Connect to 93.184.216.34')
  })

  it('a wildcard host still takes priority over the sensitive-address branch -- "*" already means unlimited, R2-01', () => {
    const summary = describeCapabilityGrant('https.connect', ['*:443', '127.0.0.1:9000'])

    expect(summary.message).toContain('Unlimited')
  })

  // A197 says every sensitive address is named, never folded into a count --
  // decision 10's row cap still applies on top of that: past
  // MAX_LISTED_ROWS they fold into a trailing count of their own, in BOTH
  // the headline and the per-address explanation, rather than growing the
  // dialog to match however many a manifest declares (up to MAX_PATTERNS).
  it('caps the number of sensitive addresses named individually, folding the rest into a count', () => {
    const patterns = Array.from({ length: 60 }, (_, i) => `10.0.${String(i)}.1:443`)
    const summary = describeCapabilityGrant('https.connect', patterns)

    expect(summary.warning).toBe(true)
    expect(summary.message).toContain('10.0.0.1')
    expect(summary.message).toMatch(/and 40 more/)
    expect(summary.explanation).toMatch(/40 more address/)
  })
})

// A198: investigated, not reproduced. `describeCapabilityGrant` has no
// validation of its own -- it trusts whatever pattern array it is handed --
// so this calls it directly with blank-line-padded patterns, the MOST
// permissive path available (every production caller validates first: see
// this suite's own header note and ../README.md's Design notes for
// where). A pattern's own `parsePattern` (broker/policy/connect-
// patterns.ts) trims the whole string before splitting host:port, and then
// rejects anything containing a control character -- including `\n` and
// `\r` -- ANYWHERE in the trimmed text via `isAsciiHost`. Leading/trailing
// padding is silently trimmed away (never rendered); a pattern carrying an
// INTERNAL blank line fails to parse at all and is dropped from the
// summary entirely, never rendered with the padding intact. Neither
// outcome is "padding that pushes real content off-screen" -- the claim in
// A198 -- so nothing here needed a render-side fix.
describe('describeCapabilityGrant -- A198: blank-line padding does not survive into the rendered text', () => {
  it('leading/trailing blank lines around an otherwise-valid pattern are silently trimmed, never rendered', () => {
    const summary = describeCapabilityGrant('https.connect', ['\n\n\napi.example.com:443\n\n\n'])

    expect(summary.message).toBe('Connect to api.example.com')
    expect(summary.message).not.toMatch(/[\n\r]/)
  })

  it('a pattern with an INTERNAL blank line fails to parse and is dropped, not rendered padded', () => {
    const summary = describeCapabilityGrant('https.connect', ['api\n\n\n.example.com:443', 'real.example:443'])

    expect(summary.message).toBe('Connect to real.example')
    expect(summary.message).not.toMatch(/[\n\r]/)
  })

  it('a pattern that is only blank lines contributes nothing at all to the rendered summary', () => {
    const summary = describeCapabilityGrant('https.connect', ['\n\n\n\n\n\n\n\n', 'real.example:443'])

    expect(summary.message).toBe('Connect to real.example')
  })
})

// A wildcard host reaches a port Orivon keeps closed to broad grants (A82)
// only when its own pattern names that port exactly, so the prompt must say
// so, and say what the port is for: "Limited to port 6697" alone reads as a
// narrowing, and for a reserved port it is an exception a person should see.
const ANY_COMPUTER = 'This app can connect to any computer on the internet, not just specific ones.'

describe('describeCapabilityGrant -- a wildcard pattern that names a reserved port', () => {
  it('says so, by purpose, for a mixed grant naming two reserved ports, at the unlimited level', () => {
    const summary = describeCapabilityGrant('tcp.connect', ['*:*', '*:6667', '*:6697'])

    expect(summary.warning).toBe(true)
    expect(summary.message).toBe('⚠ Unlimited network access')
    expect(summary.explanation).toBe(
      `${ANY_COMPUTER} It can also reach ports Orivon keeps closed to broad grants: IRC chat (6667 and 6697).`
    )
  })

  it('names what each reserved port is for, grouped by purpose', () => {
    const ports = ['23', '25', '465', '587', '53', '139', '445', '3389', '6667', '6697']
    const summary = describeCapabilityGrant('tcp.connect', ['*:*', ...ports.map((port) => `*:${port}`)])

    expect(summary.explanation).toContain(
      'telnet (23), mail (25, 465 and 587), DNS (53), Windows file sharing (139 and 445), remote desktop (3389) and IRC chat (6667 and 6697)'
    )
  })

  it('has a purpose for every reserved port, so a new one cannot render as a bare number', () => {
    for (const port of RESERVED_PORTS) {
      const summary = describeCapabilityGrant('tcp.connect', ['*:*', `*:${String(port)}`])
      expect(summary.explanation, `port ${String(port)}`).toMatch(/keeps closed to broad grants: [A-Za-z][^(]* \(/)
      expect(summary.explanation, `port ${String(port)}`).toContain(String(port))
    }
  })

  it('drops "also" when the wildcard\'s only ports are the reserved ones it names', () => {
    const summary = describeCapabilityGrant('tcp.connect', ['*:6697'])

    expect(summary.warning).toBe(true)
    expect(summary.explanation).toBe(
      `${ANY_COMPUTER} Its reach to any computer is limited to port 6697. ` +
      'It can reach a port Orivon keeps closed to broad grants: IRC chat (6697).'
    )
  })

  it('keeps "also" when the wildcard has ordinary ports beside the reserved one', () => {
    const summary = describeCapabilityGrant('tcp.connect', ['*:443', '*:6697'])

    expect(summary.explanation).toBe(
      `${ANY_COMPUTER} Its reach to any computer is limited to ports 443, 6697. ` +
      'It can also reach a port Orivon keeps closed to broad grants: IRC chat (6697).'
    )
  })

  it('says nothing about closed ports for "*:*", an ordinary port, or a range that merely contains one', () => {
    for (const patterns of [['*:*'], ['*:443'], ['*:6660-6699']]) {
      expect(describeCapabilityGrant('tcp.connect', patterns).explanation).not.toContain('keeps closed')
    }
  })

  it('says each limit names what it limits, per kind', () => {
    expect(describeCapabilityGrant('tcp.connect', ['*:443']).explanation).toContain('Its reach to any computer is limited to port 443.')
    expect(describeCapabilityGrant('https.connect', ['*:443']).explanation).toContain('Its reach to any site is limited to port 443.')
  })

  it('writes a port once however the pattern spelt it', () => {
    const summary = describeCapabilityGrant('tcp.connect', ['*:6697-6697', '*:443', '*:443-443'])

    expect(summary.explanation).toContain('limited to ports 6697, 443.')
    expect(summary.explanation).not.toContain('6697-6697')
  })
})

describe('describeCapabilityGrant -- named patterns beside a wildcard host', () => {
  it('says what a named pattern adds that the bounded wildcard does not reach', () => {
    const summary = describeCapabilityGrant('tcp.connect', ['*:443', '192.168.1.1:22', 'irc.example.org:6697'])

    expect(summary.warning).toBe(true)
    expect(summary.explanation).toBe(
      `${ANY_COMPUTER} Its reach to any computer is limited to port 443. ` +
      'It can also reach 192.168.1.1 on port 22 (a computer on your local network) and irc.example.org on port 6697 (IRC chat).'
    )
  })

  it('says it beside a fully open wildcard too: "*:*" never reaches a local address', () => {
    const summary = describeCapabilityGrant('tcp.connect', ['*:*', '192.168.1.1:22'])

    expect(summary.explanation).toBe(
      `${ANY_COMPUTER} It can also reach 192.168.1.1 on port 22 (a computer on your local network).`
    )
  })

  it('says nothing about a named host the wildcard already covers', () => {
    const summary = describeCapabilityGrant('tcp.connect', ['*:*', 'api.example.org:443'])

    expect(summary.explanation).toBe(ANY_COMPUTER)
  })

  it('caps a long list of extras with an "and N more" count', () => {
    const extras = Array.from({ length: 25 }, (_, index) => `10.0.0.${String(index + 1)}:22`)
    const summary = describeCapabilityGrant('tcp.connect', ['*:443', ...extras])

    expect(summary.explanation).toContain('and 5 more')
  })
})

describe('a dialog listing several wildcard rows', () => {
  const ORIGIN = 'https://app.example'

  it('a merged row keeps each limit tied to the capability it limits', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] }, https: { connect: ['*:6697'] } } })
    const content = describeInstallConsent(ORIGIN, manifest, ['tcp.connect', 'https.connect'])

    expect(content.detail).toContain('This app can connect to any computer on the internet, not just specific ones. ')
    expect(content.detail).toContain('Its reach to any site is limited to port 6697.')
    expect(content.detail).not.toContain('any computer is limited')
  })

  it('keeps the reach beyond the wildcard visible at level 4, where the warning is gone', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*', '*:6697', '192.168.1.1:22'] } } })
    const content = describeInstallConsent(ORIGIN, manifest, ['tcp.connect'], [], 4)

    expect(content.warning).toBe(false)
    expect(content.detail).not.toContain('⚠')
    expect(content.detail).toContain('Unlimited network access')
    expect(content.detail).toContain('Orivon keeps closed to broad grants: IRC chat (6697)')
    expect(content.detail).toContain('192.168.1.1 on port 22 (a computer on your local network)')
  })
})
