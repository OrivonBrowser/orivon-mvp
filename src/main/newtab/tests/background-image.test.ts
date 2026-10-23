import { describe, expect, it } from 'vitest'
import { checkPicture, MAX_PICTURE_BYTES, sniffPicture } from '../background-image.js'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))
const pad = (head: number[], total = 64): Uint8Array => Uint8Array.from([...head, ...new Array<number>(Math.max(0, total - head.length)).fill(0)])

const PNG = pad([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0])
const GIF = pad(ascii('GIF89a'))
const WEBP = pad([...ascii('RIFF'), 0x10, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 ')])
const AVIF = pad([0, 0, 0, 0x1c, ...ascii('ftyp'), ...ascii('avif'), 0, 0, 0, 0, ...ascii('mif1'), ...ascii('avif')])

describe('sniffPicture', () => {
  it('names each accepted format by its leading bytes', () => {
    expect(sniffPicture(PNG)).toBe('png')
    expect(sniffPicture(JPEG)).toBe('jpeg')
    expect(sniffPicture(GIF)).toBe('gif')
    expect(sniffPicture(WEBP)).toBe('webp')
    expect(sniffPicture(AVIF)).toBe('avif')
    expect(sniffPicture(pad(ascii('GIF87a')))).toBe('gif')
  })

  it('reads an AVIF whose major brand is another but which lists avif as compatible', () => {
    const heif = pad([0, 0, 0, 0x1c, ...ascii('ftyp'), ...ascii('mif1'), 0, 0, 0, 0, ...ascii('mif1'), ...ascii('avif')])
    expect(sniffPicture(heif)).toBe('avif')
  })

  it('refuses what is not one of them, whatever it is called', () => {
    expect(sniffPicture(pad(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>')))).toBeNull()
    expect(sniffPicture(pad(ascii('<html><script>')))).toBeNull()
    expect(sniffPicture(pad([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]))).toBeNull()
    expect(sniffPicture(pad([0, 0, 0, 0x1c, ...ascii('ftyp'), ...ascii('mp42')]))).toBeNull()
    expect(sniffPicture(pad([0x89, ...ascii('PNX')]))).toBeNull()
    expect(sniffPicture(bytes())).toBeNull()
    expect(sniffPicture(bytes(0xff, 0xd8))).toBeNull()
  })
})

describe('checkPicture', () => {
  it('accepts a picture and says its type', () => {
    expect(checkPicture(PNG)).toEqual({ ok: true, type: 'png', mime: 'image/png' })
    expect(checkPicture(AVIF)).toEqual({ ok: true, type: 'avif', mime: 'image/avif' })
  })

  it('refuses a file of another kind, saying which kinds are taken', () => {
    const answer = checkPicture(pad(ascii('hello')))
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.reason).toMatch(/PNG, JPEG, WebP, GIF or AVIF/)
  })

  it('refuses an empty file and one over the size cap', () => {
    expect(checkPicture(bytes()).ok).toBe(false)
    const big = checkPicture(PNG, MAX_PICTURE_BYTES + 1)
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.reason).toMatch(/20 MB/)
    expect(checkPicture(PNG, MAX_PICTURE_BYTES).ok).toBe(true)
  })
})
