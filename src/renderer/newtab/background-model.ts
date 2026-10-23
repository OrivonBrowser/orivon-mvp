// What the page draws behind itself, out of what main answered. Pure, so the shapes it refuses run under plain vitest.

/** The pictures the page will turn into an image: main only ever answers one of these. */
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])

export type PageBackground =
  | { readonly kind: 'orivon' }
  | { readonly kind: 'none' }
  | { readonly kind: 'custom', readonly mime: string, readonly bytes: Uint8Array<ArrayBuffer> }

const ORIVON: PageBackground = { kind: 'orivon' }

/** Anything that is not a well-formed answer is the Orivon picture, so a page never fails to draw. */
export function readBackground (answer: unknown): PageBackground {
  if (typeof answer !== 'object' || answer === null) return ORIVON
  const { kind, mime, bytes } = answer as { kind?: unknown, mime?: unknown, bytes?: unknown }
  if (kind === 'none') return { kind: 'none' }
  if (kind === 'custom' && typeof mime === 'string' && PICTURE_TYPES.has(mime) && ArrayBuffer.isView(bytes) && bytes.byteLength > 0) {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    return { kind: 'custom', mime, bytes: copy }
  }
  return ORIVON
}
