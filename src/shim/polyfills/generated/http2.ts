// Generated (A287): a named export per Node `http2` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in http2.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { otherHttp2Member } from '../http2.js'

const classify = otherHttp2Member

export const Http2ServerRequest = refusingExport('Http2ServerRequest', classify)
export const Http2ServerResponse = refusingExport('Http2ServerResponse', classify)
export const connect = refusingExport('connect', classify)
export const createSecureServer = refusingExport('createSecureServer', classify)
export const createServer = refusingExport('createServer', classify)
export const getDefaultSettings = refusingExport('getDefaultSettings', classify)
export const getPackedSettings = refusingExport('getPackedSettings', classify)
export const getUnpackedSettings = refusingExport('getUnpackedSettings', classify)
export const performServerHandshake = refusingExport('performServerHandshake', classify)

/**
 * Node `http2` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = []
