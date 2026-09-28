// `zlib` module target (module-map.ts): browserify-zlib, which is gzip and
// deflate only. Every brotli member refuses by name when called: the package
// predates Node's brotli support (docs/planning/shim-dependency-review.md).

import browserifyZlib from 'browserify-zlib'
import { nodeModule } from './module-proxy.js'

export const {
  constants, createDeflate, createInflate, createDeflateRaw, createInflateRaw, createGzip, createGunzip, createUnzip,
  deflate, deflateSync, gzip, gzipSync, deflateRaw, deflateRawSync, unzip, unzipSync, inflate, inflateSync, gunzip,
  gunzipSync, inflateRaw, inflateRawSync, Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, Unzip
} = browserifyZlib

export default nodeModule('zlib', { ...browserifyZlib })
