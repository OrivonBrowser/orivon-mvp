// Shared byte-level primitives, consolidated out of two byte-identical
// `concat` copies and one shared framing core hiding inside two differently-
// typed `encodeField` functions (derive-encoding.ts, bundle-hash.ts) --
// docs/development/code-guidelines.md Rule 3. Zero imports.

/**
 * Returns Uint8Array<ArrayBuffer> rather than plain Uint8Array because
 * WebCrypto's BufferSource excludes SharedArrayBuffer-backed views. Everything
 * here is freshly allocated, so saying so costs nothing and saves a cast.
 */
export function concat (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * LENGTH PREFIXING IS NOT DECORATION -- see derive-encoding.ts's encodeField
 * for the full argument (concatenating fields directly makes two distinct
 * tuples produce the same bytes) and bundle-hash.ts's leafDigest for the
 * matching one about path and content.
 *
 * A big-endian uint32 byte length followed by the bytes themselves, which
 * makes the encoding injective: no two distinct byte strings share a framed
 * encoding. This is the framing core two call sites used to duplicate --
 * derive-encoding.ts's `encodeField(value: string)` additionally validates
 * that `value` is well-formed Unicode before framing it; bundle-hash.ts's
 * leaf construction frames already-known-good bytes directly.
 */
export function frame (bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length, false)
  out.set(bytes, 4)
  return out
}
