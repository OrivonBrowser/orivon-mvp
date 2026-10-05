import { describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import { LIMITS, asPage, fakeBridge, fakeSocketBridgeResult } from './main-world-socket.test-helpers.js'

// orivon.trust.websiteScore's own installOrivon wiring (ADR-0058), a sibling of ./main-world-socket-web.test.ts for
// the same reason: ./main-world-socket.test.ts has no room.

interface OrivonTrustSurface { trust: { websiteScore: (address: string) => Promise<{ provider: string | null, level: number | null }> } }

function install (bridge: ReturnType<typeof fakeBridge>): OrivonTrustSurface {
  const target: Record<string, unknown> = {}
  installOrivon(bridge, LIMITS, target)
  return asPage(target.orivon) as unknown as OrivonTrustSurface
}

describe('installOrivon -- trust.websiteScore', () => {
  it('delegates to bridge.trustWebsiteScore with the address, and resolves its answer unchanged', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const asked: string[] = []
    bridge.trustWebsiteScore = async (address) => { asked.push(address); return { provider: 'P', level: 3 } }
    const orivon = install(bridge)

    expect(await orivon.trust.websiteScore('ipfs://bafy')).toEqual({ provider: 'P', level: 3 })
    expect(asked).toEqual(['ipfs://bafy'])
  })

  it('rejects with the broker\'s own code when the bridge does', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.trustWebsiteScore = async () => { throw Object.assign(new Error('not granted'), { name: 'OrivonError', code: 'denied' }) }
    await expect(install(bridge).trust.websiteScore('scored.eth')).rejects.toMatchObject({ code: 'denied' })
  })
})
