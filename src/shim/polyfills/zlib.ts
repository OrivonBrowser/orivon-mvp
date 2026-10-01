// `zlib` module target (module-map.ts): browserify-zlib, which is gzip and
// deflate only. Every brotli member refuses by name when called: the package
// predates Node's brotli support (docs/planning/shim-dependency-review.md).
//
// The one-shot functions are wrapped so their input may be any ArrayBufferView or an ArrayBuffer,
// as in Node. The package takes a string or a Buffer only, and a library that hands over the plain
// Uint8Array it collected from a response (ethers' gunzipSync does) would be refused.

import browserifyZlib from 'browserify-zlib'
import { nodeModule } from './module-proxy.js'

/** The Buffer class the package itself checks for, found from what it returns: the page and the package may not share one. */
let packageBuffer: { from: (...args: unknown[]) => unknown, isBuffer: (value: unknown) => boolean } | undefined
function bufferClass (): NonNullable<typeof packageBuffer> {
  packageBuffer ??= (browserifyZlib.deflateSync('') as unknown as { constructor: NonNullable<typeof packageBuffer> }).constructor
  return packageBuffer
}

function asBuffer (input: unknown): unknown {
  if (input instanceof ArrayBuffer) return bufferClass().from(input)
  if (ArrayBuffer.isView(input) && !bufferClass().isBuffer(input)) return bufferClass().from(input.buffer, input.byteOffset, input.byteLength)
  return input
}

function acceptingViews<F> (fn: F): F {
  return ((first: unknown, ...rest: unknown[]) => (fn as unknown as (...args: unknown[]) => unknown)(asBuffer(first), ...rest)) as unknown as F
}

export const {
  constants, createDeflate, createInflate, createDeflateRaw, createInflateRaw, createGzip, createGunzip, createUnzip,
  Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, Unzip
} = browserifyZlib

export const deflate = acceptingViews(browserifyZlib.deflate)
export const deflateSync = acceptingViews(browserifyZlib.deflateSync)
export const gzip = acceptingViews(browserifyZlib.gzip)
export const gzipSync = acceptingViews(browserifyZlib.gzipSync)
export const deflateRaw = acceptingViews(browserifyZlib.deflateRaw)
export const deflateRawSync = acceptingViews(browserifyZlib.deflateRawSync)
export const unzip = acceptingViews(browserifyZlib.unzip)
export const unzipSync = acceptingViews(browserifyZlib.unzipSync)
export const inflate = acceptingViews(browserifyZlib.inflate)
export const inflateSync = acceptingViews(browserifyZlib.inflateSync)
export const gunzip = acceptingViews(browserifyZlib.gunzip)
export const gunzipSync = acceptingViews(browserifyZlib.gunzipSync)
export const inflateRaw = acceptingViews(browserifyZlib.inflateRaw)
export const inflateRawSync = acceptingViews(browserifyZlib.inflateRawSync)

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/zlib.js'

export default nodeModule('zlib', {
  ...browserifyZlib,
  deflate, deflateSync, gzip, gzipSync, deflateRaw, deflateRawSync, unzip, unzipSync, inflate, inflateSync,
  gunzip, gunzipSync, inflateRaw, inflateRawSync
})
