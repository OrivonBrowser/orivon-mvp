// `crypto` module target (module-map.ts): crypto-browserify, plus the
// members Node takes from the platform's Web Crypto (webcrypto, subtle,
// getRandomValues, randomUUID), which crypto-browserify predates. README.md's
// Design notes on T26 say what grade of primitive this is and is not.

import cryptoBrowserify from 'crypto-browserify'
import { nodeModule } from './node-module-proxy.js'

export const {
  createHash, createHmac, getHashes, pbkdf2, pbkdf2Sync, randomBytes, randomFill, randomFillSync, createCipheriv,
  createDecipheriv, getCiphers, createDiffieHellman, createDiffieHellmanGroup, getDiffieHellman, createECDH,
  createSign, createVerify, publicEncrypt, privateEncrypt, publicDecrypt, privateDecrypt, constants, Hash, Hmac,
  Cipheriv, Decipheriv, DiffieHellman, DiffieHellmanGroup, Sign, Verify
} = cryptoBrowserify

export const webcrypto = globalThis.crypto
export const subtle = globalThis.crypto.subtle
export function getRandomValues<T extends ArrayBufferView<ArrayBuffer>> (array: T): T { return globalThis.crypto.getRandomValues(array) }
export function randomUUID (): string { return globalThis.crypto.randomUUID() }

export default nodeModule('crypto', {
  ...cryptoBrowserify, webcrypto, subtle, getRandomValues, randomUUID
})
