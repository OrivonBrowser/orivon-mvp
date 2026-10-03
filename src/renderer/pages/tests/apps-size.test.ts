import { describe, expect, it } from 'vitest'
import { sizeWords } from '../settings/apps-view.js'

describe('sizeWords', () => {
  it('climbs to the next unit when the figure would read 1024 of this one', () => {
    expect(sizeWords(500)).toBe('500 bytes')
    expect(sizeWords(1536)).toBe('1.5 KB')
    expect(sizeWords(1_048_300)).toBe('1.0 MB')
    expect(sizeWords(200 * 1024 * 1024)).toBe('200 MB')
  })
})
