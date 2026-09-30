// Generated (A287): a named export per Node `crypto` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in crypto.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { nodeModuleRefusal } from '../module-proxy.js'

const classify = (prop: string) => nodeModuleRefusal('crypto', prop)

export const Certificate = refusingExport('Certificate', classify)
export const ECDH = refusingExport('ECDH', classify)
export const KeyObject = refusingExport('KeyObject', classify)
export const X509Certificate = refusingExport('X509Certificate', classify)
export const argon2 = refusingExport('argon2', classify)
export const argon2Sync = refusingExport('argon2Sync', classify)
export const checkPrime = refusingExport('checkPrime', classify)
export const checkPrimeSync = refusingExport('checkPrimeSync', classify)
export const createPrivateKey = refusingExport('createPrivateKey', classify)
export const createPublicKey = refusingExport('createPublicKey', classify)
export const createSecretKey = refusingExport('createSecretKey', classify)
export const decapsulate = refusingExport('decapsulate', classify)
export const diffieHellman = refusingExport('diffieHellman', classify)
export const encapsulate = refusingExport('encapsulate', classify)
export const generateKey = refusingExport('generateKey', classify)
export const generateKeyPair = refusingExport('generateKeyPair', classify)
export const generateKeyPairSync = refusingExport('generateKeyPairSync', classify)
export const generateKeySync = refusingExport('generateKeySync', classify)
export const generatePrime = refusingExport('generatePrime', classify)
export const generatePrimeSync = refusingExport('generatePrimeSync', classify)
export const getCipherInfo = refusingExport('getCipherInfo', classify)
export const getCurves = refusingExport('getCurves', classify)
export const getFips = refusingExport('getFips', classify)
export const hash = refusingExport('hash', classify)
export const hkdf = refusingExport('hkdf', classify)
export const hkdfSync = refusingExport('hkdfSync', classify)
export const randomInt = refusingExport('randomInt', classify)
export const scrypt = refusingExport('scrypt', classify)
export const scryptSync = refusingExport('scryptSync', classify)
export const secureHeapUsed = refusingExport('secureHeapUsed', classify)
export const setEngine = refusingExport('setEngine', classify)
export const setFips = refusingExport('setFips', classify)
export const sign = refusingExport('sign', classify)
export const timingSafeEqual = refusingExport('timingSafeEqual', classify)
export const verify = refusingExport('verify', classify)

/**
 * Node `crypto` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = []
