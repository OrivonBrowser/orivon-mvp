// Where a native addon's WebAssembly build is, for the `.node` path an app
// asks for: beside it on the app's origin, under the three names the build
// tools produce. The `.node` file itself is never fetched: machine code
// does not run here (ADR-0040).

export const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const

/**
 * The addon's path on the app's origin, from the path or URL it was asked
 * for: `file:` and same-origin URLs give their path, and `.`/`..` segments
 * are resolved. Undefined for another origin.
 */
export function addonPath (filename: string, origin: string): string | undefined {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(filename) ? new URL(filename) : new URL(filename.startsWith('/') ? filename : `/${filename}`, origin)
  if (url.protocol === 'file:') return new URL(url.pathname, origin).pathname
  return url.origin === new URL(origin).origin ? url.pathname : undefined
}

/** `file.node` -> `file.node.wasm`, `file.wasm` (emnapi), `file.wasm32-wasi.wasm` (napi-rs). */
export function addonUrls (filename: string, origin: string): string[] {
  const path = addonPath(filename, origin)
  if (path === undefined) return []
  const exact = new URL(path, origin).href
  const stem = exact.endsWith('.node') ? exact.slice(0, -'.node'.length) : exact
  return [...new Set([`${exact}.wasm`, `${stem}.wasm`, `${stem}.wasm32-wasi.wasm`])]
}

export function isWasm (bytes: Uint8Array): boolean {
  return WASM_MAGIC.every((byte, index) => bytes[index] === byte)
}
