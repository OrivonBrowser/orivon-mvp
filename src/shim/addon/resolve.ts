// Where a native addon's WebAssembly build is, for the `.node` path an app
// asks for: beside it on the app's origin, under the three names the build
// tools produce. The `.node` file itself is never fetched: machine code
// does not run here (ADR-0040).

export const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const

/** `file.node` -> `file.node.wasm`, `file.wasm` (emnapi), `file.wasm32-wasi.wasm` (napi-rs). */
export function addonUrls (filename: string, origin: string): string[] {
  const path = filename.startsWith('file://') ? new URL(filename).pathname : filename
  const url = new URL(path.startsWith('/') ? path : `/${path}`, origin)
  if (url.origin !== new URL(origin).origin) return []
  const exact = url.href
  const stem = exact.endsWith('.node') ? exact.slice(0, -'.node'.length) : exact
  return [...new Set([`${exact}.wasm`, `${stem}.wasm`, `${stem}.wasm32-wasi.wasm`])]
}

export function isWasm (bytes: Uint8Array): boolean {
  return WASM_MAGIC.every((byte, index) => bytes[index] === byte)
}
