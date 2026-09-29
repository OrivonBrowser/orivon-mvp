// Generated (A287): a named export per Node `tls` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in tls.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { otherTlsMember } from '../tls.js'

const classify = otherTlsMember

export const SecureContext = refusingExport('SecureContext', classify)
export const Server = refusingExport('Server', classify)
export const convertALPNProtocols = refusingExport('convertALPNProtocols', classify)
export const createSecureContext = refusingExport('createSecureContext', classify)
export const createServer = refusingExport('createServer', classify)
export const getCACertificates = refusingExport('getCACertificates', classify)
export const getCiphers = refusingExport('getCiphers', classify)
export const setDefaultCACertificates = refusingExport('setDefaultCACertificates', classify)

/**
 * Node `tls` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = ["CLIENT_RENEG_LIMIT","CLIENT_RENEG_WINDOW","DEFAULT_CIPHERS","DEFAULT_ECDH_CURVE","DEFAULT_MAX_VERSION","DEFAULT_MIN_VERSION","rootCertificates"]
