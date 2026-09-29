// Generated (A287): a named export per Node `zlib` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in zlib.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { nodeModuleRefusal } from '../module-proxy.js'

const classify = (prop: string) => nodeModuleRefusal('zlib', prop)

export const BrotliCompress = refusingExport('BrotliCompress', classify)
export const BrotliDecompress = refusingExport('BrotliDecompress', classify)
export const ZstdCompress = refusingExport('ZstdCompress', classify)
export const ZstdDecompress = refusingExport('ZstdDecompress', classify)
export const brotliCompress = refusingExport('brotliCompress', classify)
export const brotliCompressSync = refusingExport('brotliCompressSync', classify)
export const brotliDecompress = refusingExport('brotliDecompress', classify)
export const brotliDecompressSync = refusingExport('brotliDecompressSync', classify)
export const crc32 = refusingExport('crc32', classify)
export const createBrotliCompress = refusingExport('createBrotliCompress', classify)
export const createBrotliDecompress = refusingExport('createBrotliDecompress', classify)
export const createZstdCompress = refusingExport('createZstdCompress', classify)
export const createZstdDecompress = refusingExport('createZstdDecompress', classify)
export const zstdCompress = refusingExport('zstdCompress', classify)
export const zstdCompressSync = refusingExport('zstdCompressSync', classify)
export const zstdDecompress = refusingExport('zstdDecompress', classify)
export const zstdDecompressSync = refusingExport('zstdDecompressSync', classify)

/**
 * Node `zlib` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = ["constants"]
