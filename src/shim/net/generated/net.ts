// Generated (A287): a named export per Node `net` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in net.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { otherNetMember } from '../net.js'

const classify = otherNetMember

export const BlockList = refusingExport('BlockList', classify)
export const SocketAddress = refusingExport('SocketAddress', classify)
export const _createServerHandle = refusingExport('_createServerHandle', classify)
export const _normalizeArgs = refusingExport('_normalizeArgs', classify)
export const getDefaultAutoSelectFamily = refusingExport('getDefaultAutoSelectFamily', classify)
export const getDefaultAutoSelectFamilyAttemptTimeout = refusingExport('getDefaultAutoSelectFamilyAttemptTimeout', classify)
export const setDefaultAutoSelectFamily = refusingExport('setDefaultAutoSelectFamily', classify)
export const setDefaultAutoSelectFamilyAttemptTimeout = refusingExport('setDefaultAutoSelectFamilyAttemptTimeout', classify)

/**
 * Node `net` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = []
