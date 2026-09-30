import { describe, expect, it, vi } from 'vitest'
import type { QrSaveDeps } from '../qr-download.js'
import { MAX_PNG_BYTES, pngFrom, qrFileName, saveQrPng, uniqueName } from '../qr-download.js'

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (extra = 8): string => Buffer.from([...PNG_HEAD, ...new Array<number>(extra).fill(1)]).toString('base64')

describe('pngFrom', () => {
  it('accepts a PNG within the cap', () => {
    expect(pngFrom(png())?.length).toBe(16)
  })

  it('refuses what is not base64 text', () => {
    for (const value of [undefined, 3, null, {}, '', 'not base64!', 'data:image/png;base64,AAAA']) expect(pngFrom(value), String(value)).toBeUndefined()
  })

  it('refuses bytes that are not a PNG', () => {
    expect(pngFrom(Buffer.from('GIF89a and more bytes').toString('base64'))).toBeUndefined()
    expect(pngFrom(Buffer.from([0x89, 0x50]).toString('base64'))).toBeUndefined()
  })

  it('refuses a picture over the cap, before and after decoding', () => {
    expect(pngFrom(png(MAX_PNG_BYTES))).toBeUndefined()
    expect(pngFrom('A'.repeat(MAX_PNG_BYTES * 2))).toBeUndefined()
  })
})

describe('qrFileName', () => {
  it('is qr-<host>.png', () => {
    expect(qrFileName('https://www.example.com/a?b=c')).toBe('qr-www.example.com.png')
    expect(qrFileName('ipfs://bafybeigdyrzt/x')).toBe('qr-bafybeigdyrzt.png')
  })

  it('keeps only letters, digits, dots and hyphens of the host', () => {
    expect(qrFileName('https://ex_ample.com/')).toBe('qr-example.com.png')
    expect(qrFileName('http://[::1]:80/')).toBe('qr-page.png')
    expect(qrFileName('not a url')).toBe('qr-page.png')
    expect(qrFileName('file:///etc/passwd')).toBe('qr-page.png')
  })

  it('never lets the name climb out of the folder', () => {
    expect(qrFileName('https://..%2f..%2fetc.example/')).not.toMatch(/[/\\]/)
    expect(qrFileName(`https://${'a'.repeat(200)}.com/`).length).toBeLessThan(80)
  })
})

describe('uniqueName', () => {
  it('counts up past names that are taken', () => {
    const taken = new Set(['/d/qr-a.png', '/d/qr-a (2).png'])
    expect(uniqueName('/d', 'qr-a.png', (path) => taken.has(path))).toBe('/d/qr-a (3).png')
    expect(uniqueName('/d', 'qr-b.png', (path) => taken.has(path))).toBe('/d/qr-b.png')
  })
})

describe('saveQrPng', () => {
  const deps = (): QrSaveDeps & { writeFile: ReturnType<typeof vi.fn<QrSaveDeps['writeFile']>> } => ({ downloadsDir: () => '/d', exists: () => false, writeFile: vi.fn<QrSaveDeps['writeFile']>(async () => undefined) })

  it('writes a valid picture to the downloads folder and says where', async () => {
    const d = deps()
    expect(await saveQrPng(d, 'https://example.com/', png())).toBe('/d/qr-example.com.png')
    expect(d.writeFile).toHaveBeenCalledTimes(1)
  })

  it('writes nothing for a refused picture', async () => {
    const d = deps()
    expect(await saveQrPng(d, 'https://example.com/', 'AAAA')).toBeUndefined()
    expect(d.writeFile).not.toHaveBeenCalled()
  })

  it('reports a failed write instead of throwing', async () => {
    const d = { ...deps(), writeFile: vi.fn<QrSaveDeps['writeFile']>(async () => { throw new Error('disk full') }) }
    expect(await saveQrPng(d, 'https://example.com/', png())).toBeUndefined()
  })
})
