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
    // A view of what arrived, not a copy: it came over IPC, so its buffer is never shared memory.
    return { kind: 'custom', mime, bytes: new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength) }
  }
  return ORIVON
}

/** The address inside the first `url(...)` of a computed `background-image`, or null when it names no picture. */
export function pictureUrlOf (backgroundImage: string): string | null {
  return /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(backgroundImage)?.[1] ?? null
}
