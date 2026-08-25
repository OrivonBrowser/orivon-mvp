// Stub for bittorrent-protocol/mse.js (Message Stream Encryption).
//
// WHY THIS IS NEEDED -- a real finding for the renderer bundle.
//
// bittorrent-protocol's package.json sets `"browser": {"./mse.js": false}`,
// because mse.js needs Node's `crypto` for RC4. But index.js STATICALLY
// imports two named bindings from it:
//
//     import { MessageStreamEncryptor, nativeRC4 } from './mse.js'
//
// Browserify tolerates that -- a false-mapped module becomes an empty object
// and the names come out undefined at runtime. Rollup (and therefore Vite)
// does not: named imports from an empty stub are a hard BUILD ERROR:
//
//     "nativeRC4" is not exported by "__vite-browser-external"
//
// So any Rollup/Vite-built webtorrent renderer bundle needs this stub. It is
// not specific to Orivon's shim and it is not caused by aliasing `net`.
//
// SAFETY: bittorrent-protocol constructs the encryptor only when `peEnabled`
// is non-zero (index.js:162), and every other use is null-guarded. Orivon does
// not enable protocol encryption in v0, so this is never constructed. If that
// ever changes, the throw below makes it obvious instead of silent.
//
// The real fix, if PE is ever wanted in the renderer: mse.js already has a
// pure-JS RC4 fallback, gated on `nativeRC4`. Supplying a `crypto` shim whose
// createCipheriv throws would select that path and make MSE work in-browser.

/** Node's crypto RC4 is unavailable in the renderer; the JS fallback path. */
export const nativeRC4 = false

export class MessageStreamEncryptor {
  constructor () {
    throw new Error(
      'Protocol encryption (MSE) is not available in the Orivon renderer bundle. ' +
      'bittorrent-protocol browser-excludes mse.js. See spike/gate1a/shim/mse-stub.js.'
    )
  }
}

export default { nativeRC4, MessageStreamEncryptor }
