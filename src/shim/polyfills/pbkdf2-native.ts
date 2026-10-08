// `crypto.pbkdf2` (callback form) over SubtleCrypto where it can. crypto-browserify's `pbkdf2` package asks
// SubtleCrypto only when `process.browser` is set, which an app's Node-shaped `process` never is, so on its
// own it would run every derivation as JavaScript on the page: 600,000 rounds of sha256 take about 5 s there
// and about 120 ms natively. Anything this does not take (another digest, an unusual argument, a SubtleCrypto
// refusal) goes to the package, whose answers and errors are Node's.

import { Buffer } from 'buffer'
import cryptoBrowserify from 'crypto-browserify'

const SUBTLE_HASH: Readonly<Record<string, string>> = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }

type Pbkdf2 = typeof cryptoBrowserify.pbkdf2

function bytesOf (input: unknown): Uint8Array | undefined {
  if (typeof input === 'string') return Buffer.from(input, 'utf8')
  return input instanceof Uint8Array ? input : undefined
}

export const pbkdf2 = ((...args: unknown[]): void => {
  const [password, salt, iterations, keylen, digest, callback] = args
  const fallback = (): void => { (cryptoBrowserify.pbkdf2 as (...rest: unknown[]) => void)(...args) }
  const hash = typeof digest === 'string' ? SUBTLE_HASH[digest] : undefined
  const subtle = globalThis.crypto?.subtle as SubtleCrypto | undefined
  const passwordBytes = bytesOf(password)
  const saltBytes = bytesOf(salt)
  if (
    hash === undefined || typeof callback !== 'function' || subtle === undefined || passwordBytes === undefined || saltBytes === undefined ||
    typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 1 ||
    typeof keylen !== 'number' || !Number.isInteger(keylen) || keylen < 1 || keylen > 0x1fffffff
  ) {
    fallback()
    return
  }
  const done = callback as (error: Error | null, key: Buffer) => void
  subtle.importKey('raw', passwordBytes as BufferSource, 'PBKDF2', false, ['deriveBits'])
    .then(async (key) => await subtle.deriveBits({ name: 'PBKDF2', hash, salt: saltBytes as BufferSource, iterations }, key, keylen * 8))
    .then((bits) => { queueMicrotask(() => { done(null, Buffer.from(bits)) }) }, fallback)
}) as Pbkdf2
