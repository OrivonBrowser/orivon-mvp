import { afterEach, describe, expect, it, vi } from 'vitest'
import { IMAGE_LIMITS, fetchArticleImages, fetchImage, sniffImageType } from '../reader-images.js'
import type { ImageFetcher } from '../reader-images.js'

afterEach(() => { vi.useRealTimers() })

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const PAGE = 'https://example.com/post'

function reply (bytes: Uint8Array, type = 'image/png', status = 200, extra: Record<string, string> = {}): Response {
  return new Response(bytes as unknown as BodyInit, { status, headers: { 'content-type': type, ...extra } })
}
const serving = (response: () => Response): ImageFetcher => async () => await Promise.resolve(response())

describe('sniffImageType', () => {
  it('names the raster formats by their first bytes and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe('image/gif')
    expect(sniffImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    expect(sniffImageType(Uint8Array.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBe('image/avif')
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImageType(new TextEncoder().encode('<html>'))).toBeNull()
  })
})

describe('fetchImage', () => {
  it('returns a data URL for a small raster image', async () => {
    const url = await fetchImage(serving(() => reply(PNG)), 'https://img.test/a.png', PAGE)
    expect(url).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
  })

  it('refuses a vector image, other types, and a body that is not what its type says', async () => {
    expect(await fetchImage(serving(() => reply(PNG, 'image/svg+xml')), 'https://img.test/a.svg', PAGE)).toBeNull()
    expect(await fetchImage(serving(() => reply(PNG, 'text/html')), 'https://img.test/a', PAGE)).toBeNull()
    expect(await fetchImage(serving(() => reply(new TextEncoder().encode('<script>alert(1)</script>'), 'image/png')), 'https://img.test/a.png', PAGE)).toBeNull()
  })

  it('refuses an error status, an empty body and addresses that are not http(s)', async () => {
    expect(await fetchImage(serving(() => reply(PNG, 'image/png', 404)), 'https://img.test/a.png', PAGE)).toBeNull()
    expect(await fetchImage(serving(() => reply(new Uint8Array(0))), 'https://img.test/a.png', PAGE)).toBeNull()
    const fetcher = vi.fn<ImageFetcher>()
    for (const address of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'javascript:1', 'ftp://a.test/x.png']) {
      expect(await fetchImage(fetcher, address, PAGE)).toBeNull()
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses a picture over the size cap, by its header and while reading', async () => {
    const big = new Uint8Array(IMAGE_LIMITS.bytes + 10)
    big.set(PNG)
    expect(await fetchImage(serving(() => reply(big)), 'https://img.test/a.png', PAGE)).toBeNull()
    expect(await fetchImage(serving(() => reply(PNG, 'image/png', 200, { 'content-length': String(IMAGE_LIMITS.bytes + 1) })), 'https://img.test/a.png', PAGE)).toBeNull()
    const stream = new ReadableStream<Uint8Array>({ pull (controller) { controller.enqueue(new Uint8Array(500_000).fill(1)) } })
    const endless = new Response(stream, { headers: { 'content-type': 'image/png' } })
    expect(await fetchImage(serving(() => endless), 'https://img.test/a.png', PAGE)).toBeNull()
  })

  it('asks without credentials and says where the reader came from', async () => {
    const fetcher = vi.fn<ImageFetcher>(async () => await Promise.resolve(reply(PNG)))
    await fetchImage(fetcher, 'https://img.test/a.png', PAGE)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', referrer: PAGE })
  })

  it('gives up on a fetch that never ends', async () => {
    vi.useFakeTimers()
    const hanging: ImageFetcher = async (_url, init) => await new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => { reject(new Error('aborted')) }) })
    const pending = fetchImage(hanging, 'https://img.test/a.png', PAGE)
    await vi.advanceTimersByTimeAsync(IMAGE_LIMITS.ms + 10)
    expect(await pending).toBeNull()
    vi.useRealTimers()
  })
})

describe('fetchArticleImages', () => {
  const slots = Array.from({ length: 20 }, (_, at) => ({ at: at * 2, src: `https://img.test/${String(at)}.png` }))

  it('copies at most twelve pictures and reports each place', async () => {
    const seen: number[] = []
    await fetchArticleImages(slots, serving(() => reply(PNG)), PAGE, (at) => { seen.push(at) }, () => true)
    expect(seen.sort((a, b) => a - b)).toEqual(slots.slice(0, IMAGE_LIMITS.count).map((slot) => slot.at))
  })

  it('stops when the reader has closed, and skips a picture that failed', async () => {
    const seen: number[] = []
    let open = true
    await fetchArticleImages(slots, async () => { open = false; return await Promise.resolve(reply(PNG)) }, PAGE, (at) => { seen.push(at) }, () => open)
    expect(seen.length).toBeLessThanOrEqual(IMAGE_LIMITS.parallel)
    const failing: number[] = []
    await fetchArticleImages(slots.slice(0, 3), serving(() => reply(PNG, 'text/plain')), PAGE, (at) => { failing.push(at) }, () => true)
    expect(failing).toEqual([])
  })
})
