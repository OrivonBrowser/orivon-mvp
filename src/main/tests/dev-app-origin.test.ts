import { describe, expect, it, vi } from 'vitest'
import { grantDevOrigin, isDevGrantableOrigin, MAX_DEV_MANIFEST_BYTES } from '../dev-app-origin.js'
import type { Broker } from '../../broker/broker-contracts.js'

const MANIFEST = {
  orivonApiVersion: 0,
  id: 'dev.example.app',
  name: 'Example',
  version: '1.0.0',
  entry: 'index.html',
  capabilities: { net: { https: { connect: ['api.example.com:443'] } } }
}

function fakeBroker (registered = false, held: ReadonlyArray<{ capability: string, patterns: readonly string[] }> = []): { broker: Broker, registerApp: ReturnType<typeof vi.fn>, grant: ReturnType<typeof vi.fn> } {
  const registerApp = vi.fn(async () => {})
  const grant = vi.fn(async () => ({}))
  const grants = held.map((entry, index) => ({ id: `g${String(index)}`, origin: 'http://127.0.0.1:8874', grantedAt: 0, ...entry }))
  const broker = {
    registerApp,
    grant,
    declinedCapabilitiesFor: async () => undefined,
    recordDeclinedCapabilities: async () => {},
    clearDeclinedConsent: async () => {},
    app: { isRegisteredSync: () => registered, grants: async () => grants }
  } as unknown as Broker
  return { broker, registerApp, grant }
}

const okFetch = (text: string) => async () => ({ ok: true, status: 200, text })

describe('isDevGrantableOrigin', () => {
  it('accepts loopback literals only when developer mode is on', () => {
    expect(isDevGrantableOrigin('http://127.0.0.1:8874', true)).toBe(true)
    expect(isDevGrantableOrigin('https://127.0.0.1:8874', true)).toBe(true)
    expect(isDevGrantableOrigin('http://[::1]:8874', true)).toBe(true)
  })

  it('refuses everything when developer mode is off -- a packaged build can never take this path', () => {
    expect(isDevGrantableOrigin('http://127.0.0.1:8874', false)).toBe(false)
  })

  it('refuses any non-loopback origin, so this never widens the real install path', () => {
    for (const origin of ['https://example.com', 'http://10.0.0.5:80', 'http://192.168.1.9:8874', 'https://169.254.169.254']) {
      expect(isDevGrantableOrigin(origin, true)).toBe(false)
    }
  })

  it('refuses a NAME that merely resolves to loopback -- resolver-dependent, and DNS could move it', () => {
    expect(isDevGrantableOrigin('http://localhost:8874', true)).toBe(false)
    expect(isDevGrantableOrigin('http://app.localhost:8874', true)).toBe(false)
  })

  it('refuses a non-http scheme and an unparseable origin', () => {
    expect(isDevGrantableOrigin('file:///tmp', true)).toBe(false)
    expect(isDevGrantableOrigin('not a url', true)).toBe(false)
  })

  // orivon-ports' fake `.eth` convention -- see this function's own header
  // for why it is accepted despite not being a loopback literal, and why
  // https is refused for it even though loopback allows either scheme.
  it('accepts a plain-http .eth origin only when developer mode is on', () => {
    expect(isDevGrantableOrigin('http://freetube.eth', true)).toBe(true)
    expect(isDevGrantableOrigin('http://freetube.eth', false)).toBe(false)
  })

  it('refuses https for a .eth origin -- no such name ever presents a real certificate', () => {
    expect(isDevGrantableOrigin('https://freetube.eth', true)).toBe(false)
  })

  it('is case-insensitive on a .eth origin, the way URL already lowercases a real host', () => {
    expect(isDevGrantableOrigin('http://FreeTube.ETH', true)).toBe(true)
  })

  it('refuses a name that merely ends with the letters "eth" without the dot, and a multi-label one', () => {
    for (const origin of ['http://acecameth', 'http://sub.freetube.eth']) {
      expect(isDevGrantableOrigin(origin, true)).toBe(false)
    }
  })
})

describe('grantDevOrigin', () => {
  it('registers the origin and asks for consent, without any bundle', async () => {
    const { broker, registerApp } = fakeBroker()
    const consent = vi.fn(async () => true)
    const result = await grantDevOrigin(
      { broker, fetchManifest: okFetch(JSON.stringify(MANIFEST)), consent },
      'http://127.0.0.1:8874'
    )
    expect(result).toEqual({ outcome: 'dev-granted', canonicalOrigin: 'http://127.0.0.1:8874', newlyRegistered: true })
    expect(registerApp).toHaveBeenCalledOnce()
    expect(consent).toHaveBeenCalledOnce()
  })

  it('fetches the manifest from the well-known path, never from a hinted path', async () => {
    const { broker } = fakeBroker()
    const fetchManifest = vi.fn(okFetch(JSON.stringify(MANIFEST)))
    await grantDevOrigin({ broker, fetchManifest, consent: async () => true }, 'http://127.0.0.1:8874')
    expect(fetchManifest).toHaveBeenCalledWith('http://127.0.0.1:8874/.well-known/orivon.json')
  })

  it('reports newlyRegistered false for an origin already registered, so no reload is forced', async () => {
    const { broker } = fakeBroker(true)
    const result = await grantDevOrigin(
      { broker, fetchManifest: okFetch(JSON.stringify(MANIFEST)), consent: async () => true },
      'http://127.0.0.1:8874'
    )
    expect(result).toEqual({ outcome: 'dev-granted', canonicalOrigin: 'http://127.0.0.1:8874', newlyRegistered: false })
  })

  it('rejects without registering when the manifest is missing, malformed or invalid', async () => {
    const cases: Array<[string, () => Promise<{ ok: boolean, status: number, text: string }>]> = [
      ['404', async () => ({ ok: false, status: 404, text: '' })],
      ['not json', okFetch('<!doctype html>')],
      ['not a manifest', okFetch(JSON.stringify({ hello: 'world' }))],
      ['over the byte cap', okFetch('x'.repeat(MAX_DEV_MANIFEST_BYTES + 1))]
    ]
    for (const [label, fetchManifest] of cases) {
      const { broker, registerApp } = fakeBroker()
      const result = await grantDevOrigin({ broker, fetchManifest, consent: async () => true }, 'http://127.0.0.1:8874')
      expect(result.outcome, label).toBe('rejected')
      expect(registerApp, label).not.toHaveBeenCalled()
    }
  })

  it('rejects rather than throwing when the fetch itself fails', async () => {
    const { broker, registerApp } = fakeBroker()
    const result = await grantDevOrigin(
      { broker, fetchManifest: async () => { throw new Error('ECONNREFUSED') }, consent: async () => true },
      'http://127.0.0.1:8874'
    )
    expect(result.outcome).toBe('rejected')
    expect(registerApp).not.toHaveBeenCalled()
  })

  it('refuses a re-hint whose manifest WIDENS a held grant, before registering it or prompting -- an all-or-nothing accept would re-grant it under a row labelled already allowed', async () => {
    const { broker, registerApp } = fakeBroker(true, [{ capability: 'https.connect', patterns: ['api.example.com:443'] }])
    const consent = vi.fn(async () => true)
    const widened = { ...MANIFEST, capabilities: { net: { https: { connect: ['*:*'] } }, fs: { quotaBytes: 1024 } } }
    const result = await grantDevOrigin({ broker, fetchManifest: okFetch(JSON.stringify(widened)), consent }, 'http://127.0.0.1:8874')
    expect(result.outcome).toBe('rejected')
    expect(registerApp).not.toHaveBeenCalled()
    expect(consent).not.toHaveBeenCalled()
  })

  it('still prompts when a re-hint only ADDS a capability, leaving held ones as they were', async () => {
    const { broker, registerApp } = fakeBroker(true, [{ capability: 'https.connect', patterns: ['api.example.com:443'] }])
    const consent = vi.fn(async () => true)
    const added = { ...MANIFEST, capabilities: { ...MANIFEST.capabilities, fs: { quotaBytes: 1024 } } }
    const result = await grantDevOrigin({ broker, fetchManifest: okFetch(JSON.stringify(added)), consent }, 'http://127.0.0.1:8874')
    expect(result).toEqual({ outcome: 'dev-granted', canonicalOrigin: 'http://127.0.0.1:8874', newlyRegistered: false })
    expect(registerApp).toHaveBeenCalledOnce()
    expect(consent).toHaveBeenCalledOnce()
  })
})
