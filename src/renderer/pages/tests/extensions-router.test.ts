import { describe, expect, it } from 'vitest'
import { pathFor, placeFor } from '../extensions/router.js'

describe('placeFor', () => {
  it('knows the three places, and asks for no change when the address is canonical', () => {
    expect(placeFor('/', '')).toEqual({ view: 'list', id: null, canonical: null })
    expect(placeFor('/shortcuts', '')).toEqual({ view: 'shortcuts', id: null, canonical: null })
    expect(placeFor('/details', '?id=abc')).toEqual({ view: 'details', id: 'abc', canonical: null })
  })

  it.each([['', ''], ['/nope', ''], ['/nope/deeper', '?id=a'], ['/__proto__', ''], ['/toString', '']])('falls back to the list for %j', (path, search) => {
    expect(placeFor(path, search)).toEqual({ view: 'list', id: null, canonical: '/' })
  })

  it('sends a details address with no extension to the list', () => {
    expect(placeFor('/details', '')).toMatchObject({ view: 'list', canonical: '/' })
    expect(placeFor('/errors', '?id=abc')).toMatchObject({ view: 'list', canonical: '/' })
  })

  it('canonicalises a trailing slash, a sub-path and extra query fields', () => {
    expect(placeFor('/shortcuts/', '')).toMatchObject({ view: 'shortcuts', canonical: '/shortcuts' })
    expect(placeFor('/details/more', '?id=abc&x=1')).toMatchObject({ view: 'details', id: 'abc', canonical: '/details?id=abc' })
  })

  it('reads an id that needed escaping', () => {
    expect(placeFor('/details', '?id=a%20b%26c')).toMatchObject({ id: 'a b&c' })
  })
})

describe('pathFor', () => {
  it('is the inverse of placeFor for every view', () => {
    for (const [view, id] of [['list', undefined], ['shortcuts', undefined], ['details', 'a b&c']] as const) {
      const url = new URL(pathFor(view, id), 'orivon://extensions')
      const place = placeFor(url.pathname, url.search)
      expect(place).toMatchObject({ view, canonical: null })
      if (id !== undefined) expect(place.id).toBe(id)
    }
  })
})
