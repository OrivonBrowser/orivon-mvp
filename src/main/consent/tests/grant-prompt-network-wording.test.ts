import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant, describeInstallConsent } from '../grant-prompt-render.js'
import { summaryAtLevel } from '../grant-level.js'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// An app that asks to reach anywhere over three different kinds of
// connection (a torrent client is the usual one) must not show three rows that
// read alike: each unlimited row says, after the shared headline, what that
// kind of grant is for.

const ORIGIN = 'https://torrent.example'

describe('unlimited network access -- each kind says what it is for', () => {
  it('words tcp.connect, https.connect and udp.send differently', () => {
    const tcp = describeCapabilityGrant('tcp.connect', ['*:*'])
    const https = describeCapabilityGrant('https.connect', ['*:*'])
    const udp = describeCapabilityGrant('udp.send', ['*:*'])

    expect(tcp.message).toBe('⚠ Unlimited network access: open direct connections to any computer on the internet')
    expect(https.message).toBe("⚠ Unlimited network access: load anything from any website, without the browser's usual limits")
    expect(udp.message).toBe('⚠ Unlimited network access: send data directly to any computer (used for peer-to-peer transfers and calls)')
    expect(new Set([tcp.message, https.message, udp.message]).size).toBe(3)
  })

  it('keeps the warning and the explanation for every kind', () => {
    for (const kind of ['tcp.connect', 'https.connect', 'udp.send'] as const) {
      const summary = describeCapabilityGrant(kind, ['*:*'])
      expect(summary.warning).toBe(true)
      expect(summary.explanation).toContain('not just specific ones')
    }
  })

  it('words a wildcard host on one port the same way: the headline is about the host', () => {
    expect(describeCapabilityGrant('https.connect', ['*:443']).message)
      .toBe("⚠ Unlimited network access: load anything from any website, without the browser's usual limits")
  })

  it('shows a torrent client three distinct rows in the install dialog', () => {
    const manifest = manifestWith({
      net: {
        tcp: { connect: ['*:*'], listen: { network: ['49152-65535'] } },
        udp: { bind: { network: ['49152-65535'] }, send: ['*:*'] },
        https: { connect: ['*:*'] }
      }
    })
    const content = describeInstallConsent(ORIGIN, manifest, ['tcp.connect', 'tcp.listen.network', 'udp.bind.network', 'udp.send', 'https.connect'])
    const unlimited = content.detail.split('\n').filter((line) => line.startsWith('- ⚠ Unlimited network access'))

    expect(unlimited).toHaveLength(3)
    expect(new Set(unlimited).size).toBe(3)
    expect(content.detail).toContain('Accepts connections and data from other computers on port 49152-65535')
  })

  it('drops only the mark at level 4, keeping the purpose', () => {
    const summary = summaryAtLevel(describeCapabilityGrant('udp.send', ['*:*']), 4)

    expect(summary.warning).toBe(false)
    expect(summary.message).toBe('Unlimited network access: send data directly to any computer (used for peer-to-peer transfers and calls)')
  })

  it('still words a narrow grant by host, with no headline', () => {
    expect(describeCapabilityGrant('udp.send', ['a.example:3478']).message).toBe('Send data to a.example')
  })
})
