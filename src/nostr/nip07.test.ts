import { describe, expect, it, vi } from 'vitest'
import type { IdentityHandle, Orivon } from '../contracts/index.js'
import { computeEventId } from './nip01.js'
import type { NostrSigner } from './nip07.js'
import { createNostrProvider, orivonIdentitySigner } from './nip07.js'

function notImplemented (name: string) {
  return () => {
    throw new Error(`unexpected call: ${name}`)
  }
}

/**
 * A fully-typed fake Orivon -- every branch not exercised by a given test
 * throws rather than silently resolving, so a test that accidentally reaches
 * an unstubbed capability fails loudly instead of passing by accident.
 */
function fakeOrivon (requestIdentity: Orivon['id']['requestIdentity']): Orivon {
  return {
    version: 0,
    app: {
      manifest: notImplemented('app.manifest'),
      grants: notImplemented('app.grants'),
      requestGrant: notImplemented('app.requestGrant')
    },
    net: {
      connect: notImplemented('net.connect'),
      listen: notImplemented('net.listen'),
      udpBind: notImplemented('net.udpBind')
    },
    fs: {
      readFile: notImplemented('fs.readFile'),
      writeFile: notImplemented('fs.writeFile'),
      open: notImplemented('fs.open'),
      mkdir: notImplemented('fs.mkdir'),
      readdir: notImplemented('fs.readdir'),
      stat: notImplemented('fs.stat'),
      rm: notImplemented('fs.rm'),
      rename: notImplemented('fs.rename'),
      userSelected: notImplemented('fs.userSelected')
    },
    id: {
      publicKey: notImplemented('id.publicKey'),
      sign: notImplemented('id.sign'),
      requestIdentity
    }
  }
}

const PUBKEY_BYTES = Uint8Array.from(
  Buffer.from('7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e', 'hex')
)
const PUBKEY_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'

function fakeIdentityHandle (overrides: Partial<IdentityHandle> = {}): IdentityHandle {
  return {
    id: 'handle-1',
    closed: new Promise(() => {}),
    close: async () => {},
    kind: 'nostr',
    publicKey: async () => PUBKEY_BYTES,
    signEvent: notImplemented('handle.signEvent'),
    ...overrides
  }
}

describe('createNostrProvider.getPublicKey', () => {
  it('resolves the identity handle\'s public key as lowercase hex', async () => {
    const orivon = fakeOrivon(async () => fakeIdentityHandle())
    const provider = createNostrProvider(orivon, { sign: notImplemented('sign') as unknown as NostrSigner })

    await expect(provider.getPublicKey()).resolves.toBe(PUBKEY_HEX)
  })

  it('rejects with code "denied" when the user declines the connect prompt', async () => {
    const orivon = fakeOrivon(async () => null)
    const provider = createNostrProvider(orivon, { sign: notImplemented('sign') as unknown as NostrSigner })

    await expect(provider.getPublicKey()).rejects.toMatchObject({ code: 'denied' })
  })

  it('requests the "nostr" identity kind specifically', async () => {
    const requestIdentity = vi.fn(async () => fakeIdentityHandle())
    const orivon = fakeOrivon(requestIdentity)
    const provider = createNostrProvider(orivon, { sign: notImplemented('sign') as unknown as NostrSigner })

    await provider.getPublicKey()

    expect(requestIdentity).toHaveBeenCalledWith({ kind: 'nostr' })
  })
})

describe('createNostrProvider.signEvent', () => {
  async function signedEventFor (event: { created_at: number, kind: number, tags: string[][], content: string }) {
    const id = await computeEventId({ ...event, pubkey: PUBKEY_HEX })
    return { ...event, id, pubkey: PUBKEY_HEX, sig: 'fake-signature-bytes-as-hex' }
  }

  it('rejects malformed input before ever calling the injected signer (zero real crypto in this module)', async () => {
    const sign = vi.fn()
    const orivon = fakeOrivon(notImplemented('id.requestIdentity'))
    const provider = createNostrProvider(orivon, { sign: sign as unknown as NostrSigner })

    // @ts-expect-error -- deliberately malformed: content is missing
    await expect(provider.signEvent({ created_at: 1, kind: 1, tags: [] })).rejects.toMatchObject({ code: 'invalid' })
    expect(sign).not.toHaveBeenCalled()
  })

  it('passes the "silent" hint for a screened-silent kind (1)', async () => {
    const event = { created_at: 1700000000, kind: 1, tags: [], content: 'hi' }
    const sign = vi.fn(async () => signedEventFor(event))
    const orivon = fakeOrivon(notImplemented('id.requestIdentity'))
    const provider = createNostrProvider(orivon, { sign })

    await provider.signEvent(event)

    expect(sign).toHaveBeenCalledWith(event, 'silent')
  })

  it('passes the "prompt" hint for a screened-prompt kind (0)', async () => {
    const event = { created_at: 1700000000, kind: 0, tags: [], content: '{}' }
    const sign = vi.fn(async () => signedEventFor(event))
    const orivon = fakeOrivon(notImplemented('id.requestIdentity'))
    const provider = createNostrProvider(orivon, { sign })

    await provider.signEvent(event)

    expect(sign).toHaveBeenCalledWith(event, 'prompt')
  })

  it('returns the signed event the injected signer produced', async () => {
    const event = { created_at: 1700000000, kind: 1, tags: [], content: 'hi' }
    const expected = await signedEventFor(event)
    const sign = vi.fn(async () => expected)
    const orivon = fakeOrivon(notImplemented('id.requestIdentity'))
    const provider = createNostrProvider(orivon, { sign })

    await expect(provider.signEvent(event)).resolves.toEqual(expected)
  })

  it('rejects with code "internal" when the signer returns an event whose id does not match its own fields', async () => {
    const event = { created_at: 1700000000, kind: 1, tags: [], content: 'hi' }
    const real = await signedEventFor(event)
    const corrupted = { ...real, id: 'a'.repeat(64) }
    const sign = vi.fn(async () => corrupted)
    const orivon = fakeOrivon(notImplemented('id.requestIdentity'))
    const provider = createNostrProvider(orivon, { sign })

    await expect(provider.signEvent(event)).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('createNostrProvider.getRelays', () => {
  it('resolves an empty relay map -- Orivon has no relay-list capability to report', async () => {
    const orivon = fakeOrivon(notImplemented('id.requestIdentity'))
    const provider = createNostrProvider(orivon, { sign: notImplemented('sign') as unknown as NostrSigner })

    await expect(provider.getRelays()).resolves.toEqual({})
  })
})

describe('orivonIdentitySigner -- the real, orivon.id-wired path', () => {
  it('acquires the nostr identity and forwards the event to handle.signEvent unchanged', async () => {
    const event = { created_at: 1700000000, kind: 1, tags: [], content: 'hi' }
    const returned = { ...event, id: 'x'.repeat(64), pubkey: PUBKEY_HEX, sig: 'sig' }
    const signEvent = vi.fn(async () => returned)
    const handle = fakeIdentityHandle({ signEvent })
    const orivon = fakeOrivon(async () => handle)

    const sign = orivonIdentitySigner(orivon)
    const result = await sign(event, 'silent')

    expect(signEvent).toHaveBeenCalledWith(event)
    expect(result).toEqual(returned)
  })

  it('rejects with code "denied" when the connect prompt is declined', async () => {
    const orivon = fakeOrivon(async () => null)
    const sign = orivonIdentitySigner(orivon)

    await expect(sign({ created_at: 1, kind: 1, tags: [], content: '' }, 'silent'))
      .rejects.toMatchObject({ code: 'denied' })
  })
})
