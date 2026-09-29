// Generated (A287): a named export per Node `util` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in util.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { nodeModuleRefusal } from '../module-proxy.js'

const classify = (prop: string) => nodeModuleRefusal('util', prop)

export const MIMEParams = refusingExport('MIMEParams', classify)
export const MIMEType = refusingExport('MIMEType', classify)
export const _errnoException = refusingExport('_errnoException', classify)
export const _exceptionWithHostPort = refusingExport('_exceptionWithHostPort', classify)
export const aborted = refusingExport('aborted', classify)
export const debug = refusingExport('debug', classify)
export const diff = refusingExport('diff', classify)
export const formatWithOptions = refusingExport('formatWithOptions', classify)
export const getCallSites = refusingExport('getCallSites', classify)
export const getSystemErrorMap = refusingExport('getSystemErrorMap', classify)
export const getSystemErrorMessage = refusingExport('getSystemErrorMessage', classify)
export const getSystemErrorName = refusingExport('getSystemErrorName', classify)
export const parseArgs = refusingExport('parseArgs', classify)
export const parseEnv = refusingExport('parseEnv', classify)
export const setTraceSigInt = refusingExport('setTraceSigInt', classify)
export const stripVTControlCharacters = refusingExport('stripVTControlCharacters', classify)
export const styleText = refusingExport('styleText', classify)
export const toUSVString = refusingExport('toUSVString', classify)
export const transferableAbortController = refusingExport('transferableAbortController', classify)
export const transferableAbortSignal = refusingExport('transferableAbortSignal', classify)

/**
 * Node `util` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = []
