// Generated (A287): a named export per Node `module` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in module.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { nodeModuleRefusal } from '../module-proxy.js'

const classify = (prop: string) => nodeModuleRefusal('module', prop)

export const Module = refusingExport('Module', classify)
export const SourceMap = refusingExport('SourceMap', classify)
export const _debug = refusingExport('_debug', classify)
export const _findPath = refusingExport('_findPath', classify)
export const _initPaths = refusingExport('_initPaths', classify)
export const _load = refusingExport('_load', classify)
export const _nodeModulePaths = refusingExport('_nodeModulePaths', classify)
export const _preloadModules = refusingExport('_preloadModules', classify)
export const _resolveFilename = refusingExport('_resolveFilename', classify)
export const _resolveLookupPaths = refusingExport('_resolveLookupPaths', classify)
export const enableCompileCache = refusingExport('enableCompileCache', classify)
export const findPackageJSON = refusingExport('findPackageJSON', classify)
export const findSourceMap = refusingExport('findSourceMap', classify)
export const flushCompileCache = refusingExport('flushCompileCache', classify)
export const getCompileCacheDir = refusingExport('getCompileCacheDir', classify)
export const getSourceMapsSupport = refusingExport('getSourceMapsSupport', classify)
export const register = refusingExport('register', classify)
export const registerHooks = refusingExport('registerHooks', classify)
export const runMain = refusingExport('runMain', classify)
export const setSourceMapsSupport = refusingExport('setSourceMapsSupport', classify)
export const stripTypeScriptTypes = refusingExport('stripTypeScriptTypes', classify)
export const syncBuiltinESMExports = refusingExport('syncBuiltinESMExports', classify)

/**
 * Node `module` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = ["_cache","_extensions","_pathCache","constants","globalPaths"]
