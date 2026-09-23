// Types for the polyfill packages' own files, which ship none. Each borrows
// Node's declaration of the module it stands in for, narrowed to what the
// package really exports.

declare module 'os-browserify/browser.js' {
  import type * as os from 'node:os'
  const browserOs: Pick<typeof os,
    'EOL' | 'arch' | 'cpus' | 'endianness' | 'freemem' | 'homedir' | 'hostname' | 'loadavg' |
    'networkInterfaces' | 'platform' | 'release' | 'tmpdir' | 'totalmem' | 'type' | 'uptime'>
  export default browserOs
}

declare module 'util/util.js' {
  import type * as util from 'node:util'
  const utilPackage: Pick<typeof util,
    'callbackify' | 'debuglog' | 'deprecate' | 'format' | 'inherits' | 'inspect' | 'promisify' | 'types'>
  export default utilPackage
}

declare module 'path-browserify' {
  import type * as path from 'node:path'
  const pathBrowserify: typeof path.posix
  export default pathBrowserify
}

declare module 'crypto-browserify' {
  import type * as crypto from 'node:crypto'
  const cryptoBrowserify: Pick<typeof crypto,
    'createHash' | 'createHmac' | 'getHashes' | 'pbkdf2' | 'pbkdf2Sync' | 'randomBytes' | 'randomFill' | 'randomFillSync' |
    'createCipheriv' | 'createDecipheriv' | 'getCiphers' | 'createDiffieHellman' | 'createDiffieHellmanGroup' |
    'getDiffieHellman' | 'createECDH' | 'createSign' | 'createVerify' | 'publicEncrypt' | 'privateEncrypt' |
    'publicDecrypt' | 'privateDecrypt' | 'constants' | 'Hash' | 'Hmac' | 'Cipheriv' | 'Decipheriv' | 'DiffieHellman' |
    'DiffieHellmanGroup' | 'Sign' | 'Verify'>
  export default cryptoBrowserify
}

declare module 'browserify-zlib' {
  import type * as zlib from 'node:zlib'
  const browserifyZlib: Pick<typeof zlib,
    'constants' | 'createDeflate' | 'createInflate' | 'createDeflateRaw' | 'createInflateRaw' | 'createGzip' |
    'createGunzip' | 'createUnzip' | 'deflate' | 'deflateSync' | 'gzip' | 'gzipSync' | 'deflateRaw' | 'deflateRawSync' |
    'unzip' | 'unzipSync' | 'inflate' | 'inflateSync' | 'gunzip' | 'gunzipSync' | 'inflateRaw' | 'inflateRawSync' |
    'Deflate' | 'Inflate' | 'Gzip' | 'Gunzip' | 'DeflateRaw' | 'InflateRaw' | 'Unzip'>
  export default browserifyZlib
}
