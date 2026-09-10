import { describe, expect, it } from 'vitest'
import { describeGrantRequest } from '../grant-prompt-render.js'
import { manifestWith } from '../../broker/tests/index.test-helpers.js'

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
