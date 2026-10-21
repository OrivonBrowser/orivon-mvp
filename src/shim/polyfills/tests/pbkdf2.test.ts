// `crypto.pbkdf2` goes to SubtleCrypto for the four digests it has, whatever `process.browser` says (an app's
// Node-shaped process has none), and to crypto-browserify's package for everything else.

import { pbkdf2Sync as nodePbkdf2Sync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Buffer as ShimBuffer } from '../buffer.js'
import crypto, { pbkdf2 } from '../crypto.js'

const derive = async (...args: unknown[]): Promise<Uint8Array> => await new Promise((resolve, reject) => {
  (pbkdf2 as (...rest: unknown[]) => void)(...args, (error: Error | null, key: Uint8Array) => { if (error === null) resolve(key); else reject(error) })
})

afterEach(() => { vi.restoreAllMocks() })

describe('crypto.pbkdf2', () => {
  it('derives with SubtleCrypto for sha1, sha256, sha384 and sha512, and equals Node\'s answer', async () => {
    const deriveBits = vi.spyOn(globalThis.crypto.subtle, 'deriveBits')
    for (const digest of ['sha1', 'sha256', 'sha384', 'sha512']) {
      deriveBits.mockClear()
      const key = await derive('password', Buffer.from('salt'), 1000, 40, digest)
      expect(deriveBits).toHaveBeenCalledOnce()
      expect(key).toBeInstanceOf(ShimBuffer)
      expect(Buffer.from(key).equals(nodePbkdf2Sync('password', 'salt', 1000, 40, digest))).toBe(true)
    }
  })

  it('does not depend on process.browser, which a Node-shaped process does not have', async () => {
    expect((globalThis.process as { browser?: boolean }).browser).toBeUndefined()
    const deriveBits = vi.spyOn(globalThis.crypto.subtle, 'deriveBits')
    await derive(new Uint8Array([1, 2, 3]), 'salt', 10, 16, 'sha256')
    expect(deriveBits).toHaveBeenCalledOnce()
  })

  it('leaves another digest, a missing digest and bad arguments to the package, with its answers and errors', async () => {
    const deriveBits = vi.spyOn(globalThis.crypto.subtle, 'deriveBits')
    const key = await derive('password', 'salt', 10, 20, 'sha224')
    expect(Buffer.from(key).equals(nodePbkdf2Sync('password', 'salt', 10, 20, 'sha224'))).toBe(true)
    expect(() => { crypto.pbkdf2('password', 'salt', -1, 20, 'sha256', () => {}) }).toThrow()
    expect(deriveBits).not.toHaveBeenCalled()
  })

  it('falls back to the package when SubtleCrypto refuses', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'importKey').mockRejectedValue(new Error('refused'))
    const key = await derive('password', 'salt', 10, 20, 'sha256')
    expect(Buffer.from(key).equals(nodePbkdf2Sync('password', 'salt', 10, 20, 'sha256'))).toBe(true)
  })
})
