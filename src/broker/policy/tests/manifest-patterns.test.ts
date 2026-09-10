import { describe, expect, it } from 'vitest'
import type { Capabilities } from '../../../contracts/index.js'
import { patternSetFromCapabilities } from '../manifest-patterns.js'

// update.ts's PatternSet convention (its own header): a capability KIND
// present with an EMPTY array means "requested, carries no patterns" (fs,
// id); a kind ABSENT means "not requested at all". Getting this backwards is
// exactly A18/A27's failure class -- a widened manifest silently installing
// because the check compared the wrong thing. So this suite is organised
// around presence/absence, not merely value equality.
//
// Moved from src/loader/tests/update-patterns.test.ts (2026-09-10, P4-1)
// alongside the implementation -- see manifest-patterns.ts's own header.

describe('patternSetFromCapabilities', () => {
  it('maps every tcp/udp field that is present, preserving its patterns', () => {
    const capabilities: Capabilities = {
      net: {
        tcp: { connect: ['api.example.com:443'], listen: ['6881-6889'] },
        udp: { bind: ['6881-6889'], send: ['*:*'] }
      }
    }
    expect(patternSetFromCapabilities(capabilities)).toEqual({
      'tcp.connect': ['api.example.com:443'],
      'tcp.listen': ['6881-6889'],
      'udp.bind': ['6881-6889'],
      'udp.send': ['*:*']
    })
  })

  // Regression test for the gap found while wiring app.requestGrant
  // (2026-09-10, P4-1): this mapping used to skip https.connect entirely,
  // so a manifest update ADDING it installed silently (decideUpdate's
  // subset check never saw the new key) and a requestGrant() call for it
  // would have been refused as "not declared" even when it plainly was.
  it('maps https.connect, the TLS-terminated capability, preserving its patterns', () => {
    const capabilities: Capabilities = { net: { https: { connect: ['api.example.com:443'] } } }
    const result = patternSetFromCapabilities(capabilities)
    expect(result['https.connect']).toEqual(['api.example.com:443'])
  })

  it('maps fs presence to an empty array, never omits it', () => {
    const capabilities: Capabilities = { fs: { quotaBytes: 1024 } }
    const result = patternSetFromCapabilities(capabilities)
    expect(Object.hasOwn(result, 'fs')).toBe(true)
    expect(result.fs).toEqual([])
  })

  it('maps id presence to an empty array, never omits it', () => {
    const capabilities: Capabilities = { id: { curves: ['secp256k1'] } }
    const result = patternSetFromCapabilities(capabilities)
    expect(Object.hasOwn(result, 'id')).toBe(true)
    expect(result.id).toEqual([])
  })

  it('an absent capability is an absent key, not an empty array', () => {
    const result = patternSetFromCapabilities({})
    expect(Object.hasOwn(result, 'tcp.connect')).toBe(false)
    expect(Object.hasOwn(result, 'https.connect')).toBe(false)
    expect(Object.hasOwn(result, 'fs')).toBe(false)
    expect(Object.hasOwn(result, 'id')).toBe(false)
    expect(result).toEqual({})
  })

  it('net present but tcp/udp/https absent contributes no keys', () => {
    const result = patternSetFromCapabilities({ net: {} })
    expect(result).toEqual({})
  })

  it('the flagship torrent manifest (capability-api.md) maps every kind', () => {
    const capabilities: Capabilities = {
      net: {
        tcp: { connect: ['*:*'], listen: ['6881-6889'] },
        udp: { bind: ['6881-6889'], send: ['*:*'] }
      },
      fs: { quotaBytes: 53687091200 },
      id: { curves: ['secp256k1'] },
      protocols: ['magnet']
    }
    expect(patternSetFromCapabilities(capabilities)).toEqual({
      'tcp.connect': ['*:*'],
      'tcp.listen': ['6881-6889'],
      'udp.bind': ['6881-6889'],
      'udp.send': ['*:*'],
      fs: [],
      id: []
    })
  })

  it('ignores protocols -- not a CapabilityKind, carries no grant', () => {
    const result = patternSetFromCapabilities({ protocols: ['magnet'] })
    expect(result).toEqual({})
  })
})
