import { describe, expect, it } from 'vitest'
import type { Section } from '../settings/model.js'
import { pathFor, placeFor } from '../settings/router.js'

const SECTIONS: readonly Section[] = [
  { id: 'appearance', title: 'Appearance', rows: [] },
  { id: 'search', title: 'Search', rows: [] }
]

describe('placeFor', () => {
  it('finds the section a path names, and asks for no change when the path is canonical', () => {
    expect(placeFor('/search', SECTIONS)).toEqual({ section: SECTIONS[1], canonicalPath: null })
  })

  it.each(['/', '', '/nope', '/nope/deeper', '/__proto__', '/toString'])('falls back to the first section for %j and says where it lives', (path) => {
    expect(placeFor(path, SECTIONS)).toEqual({ section: SECTIONS[0], canonicalPath: '/appearance' })
  })

  it('canonicalises a trailing slash or a sub-path on a real section', () => {
    expect(placeFor('/search/', SECTIONS).canonicalPath).toBe('/search')
    expect(placeFor('/search/extra', SECTIONS).canonicalPath).toBe('/search')
  })

  it('refuses a page with no sections', () => {
    expect(() => placeFor('/', [])).toThrow()
  })
})

describe('pathFor', () => {
  it('is the address of a section', () => {
    expect(pathFor(SECTIONS[1] as Section)).toBe('/search')
  })
})
