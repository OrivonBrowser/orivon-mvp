import { describe, expect, it } from 'vitest'
import { readBackground } from '../background-model.js'

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
