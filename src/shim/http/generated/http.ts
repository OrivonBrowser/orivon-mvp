// Generated (A287): a named export per Node `http` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in http.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { otherHttpMember } from '../unsupported.js'

const classify = otherHttpMember('http')

export const CloseEvent = refusingExport('CloseEvent', classify)
export const MessageEvent = refusingExport('MessageEvent', classify)
export const OutgoingMessage = refusingExport('OutgoingMessage', classify)
export const Server = refusingExport('Server', classify)
export const ServerResponse = refusingExport('ServerResponse', classify)
export const WebSocket = refusingExport('WebSocket', classify)
export const _connectionListener = refusingExport('_connectionListener', classify)
export const setMaxIdleHTTPParsers = refusingExport('setMaxIdleHTTPParsers', classify)
export const validateHeaderName = refusingExport('validateHeaderName', classify)
export const validateHeaderValue = refusingExport('validateHeaderValue', classify)

/**
 * Node `http` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = ["maxHeaderSize"]
