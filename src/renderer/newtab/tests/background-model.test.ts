import { describe, expect, it } from 'vitest'
import { pictureUrlOf, readBackground, readBrightness } from '../background-model.js'

const bytes = Uint8Array.from([1, 2, 3])

describe('readBackground', () => {
  it('reads each kind main answers', () => {
    expect(readBackground({ kind: 'orivon' })).toEqual({ kind: 'orivon' })
    expect(readBackground({ kind: 'none' })).toEqual({ kind: 'none' })
    expect(readBackground({ kind: 'custom', mime: 'image/webp', bytes })).toEqual({ kind: 'custom', mime: 'image/webp', bytes })
  })

  it.each([
    undefined, null, 'custom', 4, {}, { kind: 'wallpaper' },
    { kind: 'custom' },
    { kind: 'custom', mime: 'text/html', bytes },
    { kind: 'custom', mime: 'image/svg+xml', bytes },
    { kind: 'custom', mime: 'image/png', bytes: 'abc' },
    { kind: 'custom', mime: 'image/png', bytes: new Uint8Array(0) }
  ])('draws the Orivon picture for an answer that is not well formed: %j', (answer) => {
    expect(readBackground(answer)).toEqual({ kind: 'orivon' })
  })
})

describe('readBrightness', () => {
  it('reads a whole number of percent within the setting\'s bounds, ends included', () => {
    for (const percent of [20, 55, 100, 180]) expect(readBrightness(percent)).toBe(percent)
  })

  it.each([undefined, null, '60', 60.5, NaN, Infinity, 19, 181, 0, -50, {}, [60], true])('draws the picture at the default for an answer that is not well formed: %j', (answer) => {
    expect(readBrightness(answer)).toBe(80)
  })
})

describe('pictureUrlOf', () => {
  it('finds the picture in a computed background-image', () => {
    expect(pictureUrlOf('url("orivon-shell://renderer/assets/new-tab-background-abc.webp")'))
      .toBe('orivon-shell://renderer/assets/new-tab-background-abc.webp')
    expect(pictureUrlOf('linear-gradient(red, blue), url("blob:null/1234-5678")')).toBe('blob:null/1234-5678')
    expect(pictureUrlOf("url('a.png')")).toBe('a.png')
  })

  it('answers null when there is none', () => {
    expect(pictureUrlOf('none')).toBeNull()
    expect(pictureUrlOf('linear-gradient(red, blue)')).toBeNull()
    expect(pictureUrlOf('')).toBeNull()
  })
})
