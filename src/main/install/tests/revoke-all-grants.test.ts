import { describe, expect, it } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { baseDeps, manifestWith } from '../../../broker/tests/index.test-helpers.js'
import { revokeAllGrants } from '../revoke-all-grants.js'

const ORIGIN = 'https://app.example.com'

describe('revokeAllGrants', () => {
  it('removes every capability the origin holds, whether or not the app was ever registered', async () => {
    const broker = createBroker(baseDeps())
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })
    await broker.grant(ORIGIN, 'tcp.connect', ['api.example.com:443'])
    await broker.grant(ORIGIN, 'fs', [])
    expect((await broker.app.grants(ORIGIN)).map((grant) => grant.capability).sort()).toEqual(['fs', 'tcp.connect'])
    expect(manifest.capabilities).toBeDefined()

    await revokeAllGrants(broker, ORIGIN)

    expect(await broker.app.grants(ORIGIN)).toEqual([])
    expect(broker.app.hasGrantsSync(ORIGIN)).toBe(false)
  })

  it('touches no other origin', async () => {
    const broker = createBroker(baseDeps())
    await broker.grant(ORIGIN, 'fs', [])
    await broker.grant('https://other.example.com', 'fs', [])
    await revokeAllGrants(broker, ORIGIN)
    expect(await broker.app.grants('https://other.example.com')).toHaveLength(1)
  })

  it('does nothing, and does not throw, for an origin that holds nothing', async () => {
    const broker = createBroker(baseDeps())
    await expect(revokeAllGrants(broker, ORIGIN)).resolves.toBeUndefined()
  })

  it('keeps revoking when one removal fails, and reports it', async () => {
    const broker = createBroker(baseDeps())
    await broker.grant(ORIGIN, 'fs', [])
    await broker.grant(ORIGIN, 'tcp.connect', ['api.example.com:443'])
    const failing = { ...broker, revokePersisted: async (origin: string, capability: Parameters<typeof broker.revokePersisted>[1]) => {
      if (capability === 'fs') throw new Error('disk full')
      return await broker.revokePersisted(origin, capability)
    } }
    await expect(revokeAllGrants(failing, ORIGIN)).rejects.toThrow(/fs/)
    expect((await broker.app.grants(ORIGIN)).map((grant) => grant.capability)).toEqual(['fs'])
  })
})
