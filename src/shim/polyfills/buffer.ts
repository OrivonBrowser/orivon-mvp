// `buffer` module target (module-map.ts): the `buffer` package, plus the
// members Node's buffer module takes from the platform (Blob, atob, btoa,
// File). 'buffer/' names the package rather than this module, which the
// alias map puts at 'buffer' itself.

import bufferPackage from 'buffer/'
import { nodeModule } from './module-proxy.js'

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
export const File = globalThis.File

function bytesOf (input: unknown, api: string): Uint8Array {
  if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer)) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  throw Object.assign(new TypeError(`The "input" argument must be an instance of ArrayBuffer, Buffer or TypedArray. Received ${typeof input}`), { code: 'ERR_INVALID_ARG_TYPE', api })
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** True when `input` holds well-formed UTF-8 (`ws` asks before it hands a text frame on). */
export function isUtf8 (input: unknown): boolean {
  const bytes = bytesOf(input, 'buffer.isUtf8')
  try {
    strictUtf8.decode(bytes)
    return true
  } catch {
    return false
  }
}

/** True when every byte of `input` is 7-bit ASCII. */
export function isAscii (input: unknown): boolean {
  return bytesOf(input, 'buffer.isAscii').every((byte) => byte < 0x80)
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/buffer.js'

export default nodeModule('buffer', { Buffer, SlowBuffer, INSPECT_MAX_BYTES, kMaxLength, Blob, atob, btoa, File, isUtf8, isAscii })
