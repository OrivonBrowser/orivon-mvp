import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant } from '../grant-prompt-render.js'
import type { Pattern } from '../../contracts/index.js'

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
})

// A198: investigated, not reproduced. `describeCapabilityGrant` has no
// validation of its own -- it trusts whatever pattern array it is handed --
// so this calls it directly with blank-line-padded patterns, the MOST
// permissive path available (every production caller validates first: see
// this suite's own header note and src/main/README.md's Design notes for
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
