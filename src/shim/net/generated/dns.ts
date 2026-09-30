// Generated (A287): a named export per Node `dns` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in dns.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { otherDnsMember } from '../dns.js'

const classify = otherDnsMember

export const Resolver = refusingExport('Resolver', classify)
export const getDefaultResultOrder = refusingExport('getDefaultResultOrder', classify)
export const getServers = refusingExport('getServers', classify)
export const lookupService = refusingExport('lookupService', classify)
export const resolve = refusingExport('resolve', classify)
export const resolve4 = refusingExport('resolve4', classify)
export const resolve6 = refusingExport('resolve6', classify)
export const resolveAny = refusingExport('resolveAny', classify)
export const resolveCaa = refusingExport('resolveCaa', classify)
export const resolveCname = refusingExport('resolveCname', classify)
export const resolveMx = refusingExport('resolveMx', classify)
export const resolveNaptr = refusingExport('resolveNaptr', classify)
export const resolveNs = refusingExport('resolveNs', classify)
export const resolvePtr = refusingExport('resolvePtr', classify)
export const resolveSoa = refusingExport('resolveSoa', classify)
export const resolveSrv = refusingExport('resolveSrv', classify)
export const resolveTlsa = refusingExport('resolveTlsa', classify)
export const resolveTxt = refusingExport('resolveTxt', classify)
export const reverse = refusingExport('reverse', classify)
export const setDefaultResultOrder = refusingExport('setDefaultResultOrder', classify)
export const setServers = refusingExport('setServers', classify)

/**
 * Node `dns` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = ["ADDRCONFIG","ADDRGETNETWORKPARAMS","ALL","BADFAMILY","BADFLAGS","BADHINTS","BADNAME","BADQUERY","BADRESP","BADSTR","CANCELLED","CONNREFUSED","DESTRUCTION","EOF","FILE","FORMERR","LOADIPHLPAPI","NODATA","NOMEM","NONAME","NOTFOUND","NOTIMP","NOTINITIALIZED","REFUSED","SERVFAIL","TIMEOUT","V4MAPPED"]
