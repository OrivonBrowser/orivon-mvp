// Copies an article's pictures for the reader page, which loads nothing from the network itself. Main fetches
// each one in the source tab's session, with a cap on how many, how large and how slow, and hands the page a
// `data:` URL. Only raster images pass: a type the page names is checked against the bytes that arrive.
import { webUrl } from './reader-blocks.js'

export const IMAGE_LIMITS = { count: 12, bytes: 1_500_000, ms: 5000, parallel: 4 } as const

export type ImageFetcher = (url: string, init: { signal: AbortSignal, credentials: 'omit', referrer: string }) => Promise<Response>

const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'] as const

/** What the first bytes say the file is, whatever the server called it. */
export function sniffImageType (bytes: Uint8Array): (typeof TYPES)[number] | null {
  const at = (offset: number, ...values: number[]): boolean => values.every((value, index) => bytes[offset + index] === value)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'image/avif'
  return null
}

/** The bytes of a body, or null as soon as it is larger than `limit`. */
async function readCapped (response: Response, limit: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (reader === undefined) return null
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      void reader.cancel().catch(() => undefined)
      return null
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

/** One picture as a `data:` URL, or null for anything that is not a small enough raster image. */
export async function fetchImage (fetcher: ImageFetcher, url: string, pageUrl: string): Promise<string | null> {
  const address = webUrl(url, pageUrl)
  if (address === null) return null
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, IMAGE_LIMITS.ms)
  try {
    const response = await fetcher(address, { signal: controller.signal, credentials: 'omit', referrer: pageUrl })
    if (!response.ok) return null
    const declared = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!(TYPES as readonly string[]).includes(declared)) return null
    const length = Number(response.headers.get('content-length') ?? '0')
    if (length > IMAGE_LIMITS.bytes) return null
    const bytes = await readCapped(response, IMAGE_LIMITS.bytes)
    if (bytes === null || bytes.byteLength === 0) return null
    const type = sniffImageType(bytes)
    if (type === null) return null
    return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Fetches the article's first pictures a few at a time, telling `onImage` as each one lands. `alive` is asked
 * before each fetch, so a closed reader stops the work. */
export async function fetchArticleImages (
  slots: ReadonlyArray<{ at: number, src: string }>,
  fetcher: ImageFetcher,
  pageUrl: string,
  onImage: (at: number, dataUrl: string) => void,
  alive: () => boolean
): Promise<void> {
  const queue = slots.slice(0, IMAGE_LIMITS.count)
  const worker = async (): Promise<void> => {
    for (let slot = queue.shift(); slot !== undefined; slot = queue.shift()) {
      if (!alive()) return
      const data = await fetchImage(fetcher, slot.src, pageUrl)
      if (data !== null && alive()) onImage(slot.at, data)
    }
  }
  await Promise.all(Array.from({ length: Math.min(IMAGE_LIMITS.parallel, queue.length) }, worker))
}
