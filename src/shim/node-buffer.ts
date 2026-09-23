// `buffer` module target (module-map.ts): the `buffer` package, plus the
// members Node's buffer module takes from the platform (Blob, atob, btoa).
// 'buffer/' names the package rather than this module, which the alias
// map puts at 'buffer' itself.

import bufferPackage from 'buffer/'
import { nodeModule } from './node-module-proxy.js'

/** The package declares only Buffer; the other three are real exports it leaves untyped. */
interface BufferPackage { Buffer: typeof bufferPackage.Buffer, SlowBuffer: unknown, INSPECT_MAX_BYTES: number, kMaxLength: number }

const { Buffer: packageBuffer, SlowBuffer: packageSlowBuffer, INSPECT_MAX_BYTES, kMaxLength } = bufferPackage as unknown as BufferPackage

/**
 * The page's `Buffer` global when it is this package's class, which an app
 * tab's preload installs (src/preload/page-buffer.ts): adopting it keeps
 * `require('buffer').Buffer === Buffer`, so instanceof agrees between the
 * two. Node's own Buffer, the global under test, has no TYPED_ARRAY_SUPPORT.
 */
function pageGlobalBuffer (): typeof packageBuffer | undefined {
  const candidate = (globalThis as unknown as { Buffer?: typeof packageBuffer }).Buffer
  return typeof candidate === 'function' && 'TYPED_ARRAY_SUPPORT' in candidate ? candidate : undefined
}

const adopted = pageGlobalBuffer()

export const Buffer = adopted ?? packageBuffer
/** The package's own SlowBuffer, over whichever class Buffer is. */
export const SlowBuffer = adopted === undefined
  ? packageSlowBuffer
  : (size: unknown) => adopted.alloc(Number(size) == size ? Number(size) : 0) // eslint-disable-line eqeqeq
export { INSPECT_MAX_BYTES, kMaxLength }
export const Blob = globalThis.Blob
export const atob = globalThis.atob
export const btoa = globalThis.btoa

export default nodeModule('buffer', { Buffer, SlowBuffer, INSPECT_MAX_BYTES, kMaxLength, Blob, atob, btoa })
