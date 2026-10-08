// `crypto` module target (module-map.ts): crypto-browserify, plus the
// members Node takes from the platform's Web Crypto (webcrypto, subtle,
// getRandomValues, randomUUID), which crypto-browserify predates, and a
// pbkdf2 that reaches SubtleCrypto without `process.browser`. README.md's
// Design notes on T26 say what grade of primitive this is and is not.

import cryptoBrowserify from 'crypto-browserify'
import { nodeModule } from './module-proxy.js'
import { pbkdf2 } from './pbkdf2-native.js'

export const {
  createHash, createHmac, getHashes, pbkdf2Sync, randomBytes, randomFill, randomFillSync, createCipheriv,
  createDecipheriv, getCiphers, createDiffieHellman, createDiffieHellmanGroup, getDiffieHellman, createECDH,
  createSign, createVerify, publicEncrypt, privateEncrypt, publicDecrypt, privateDecrypt, constants, Hash, Hmac,
  Cipheriv, Decipheriv, DiffieHellman, DiffieHellmanGroup, Sign, Verify
} = cryptoBrowserify

export { pbkdf2 }

export const webcrypto = globalThis.crypto
export const subtle = globalThis.crypto.subtle
export function getRandomValues<T extends ArrayBufferView<ArrayBuffer>> (array: T): T { return globalThis.crypto.getRandomValues(array) }
export function randomUUID (): string { return globalThis.crypto.randomUUID() }

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/crypto.js'

export default nodeModule('crypto', {
  ...cryptoBrowserify, pbkdf2, webcrypto, subtle, getRandomValues, randomUUID
})
