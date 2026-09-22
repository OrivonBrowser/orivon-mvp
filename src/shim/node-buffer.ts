// `buffer` module target (module-map.ts): the `buffer` package, plus the
// members Node's buffer module takes from the platform (Blob, atob, btoa).
// 'buffer/' names the package rather than this module, which the alias
// map puts at 'buffer' itself.

import bufferPackage from 'buffer/'
import { nodeModule } from './node-module-proxy.js'

/** The package declares only Buffer; the other three are real exports it leaves untyped. */
interface BufferPackage { Buffer: typeof bufferPackage.Buffer, SlowBuffer: unknown, INSPECT_MAX_BYTES: number, kMaxLength: number }

export const { Buffer, SlowBuffer, INSPECT_MAX_BYTES, kMaxLength } = bufferPackage as unknown as BufferPackage
export const Blob = globalThis.Blob
export const atob = globalThis.atob
export const btoa = globalThis.btoa

export default nodeModule('buffer', { Buffer, SlowBuffer, INSPECT_MAX_BYTES, kMaxLength, Blob, atob, btoa })
