import { describe, expect, it } from 'vitest'
import type { Capabilities } from '../contracts/index.js'
import { patternSetFromCapabilities } from './update-patterns.js'

// update.ts's PatternSet convention (its own header): a capability KIND
// present with an EMPTY array means "requested, carries no patterns" (fs,
// id); a kind ABSENT means "not requested at all". Getting this backwards is
// exactly A18/A27's failure class -- a widened manifest silently installing
// because the check compared the wrong thing. So this suite is organised
// around presence/absence, not merely value equality.

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
    expect(Object.hasOwn(result, 'fs')).toBe(false)
    expect(Object.hasOwn(result, 'id')).toBe(false)
    expect(result).toEqual({})
  })

  it('net present but tcp/udp absent contributes no keys', () => {
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
