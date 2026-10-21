import { describe, expect, it } from 'vitest'
import { thisSiteOf } from '../view.js'

describe('thisSiteOf', () => {
  it('reads the level main sends for a site', () => {
    expect(thisSiteOf({ site: { level: 4, unscored: false } })).toEqual({ level: 4, unscored: false })
    expect(thisSiteOf({ site: { level: 2, unscored: true } })).toEqual({ level: 2, unscored: true })
  })

  it('has no site on a new tab, where nothing is marked', () => {
    expect(thisSiteOf({})).toBeNull()
    expect(thisSiteOf({ site: undefined })).toBeNull()
    expect(thisSiteOf(undefined)).toBeNull()
  })

  it.each([['a level of 0', 0], ['a level of 5', 5], ['a string', '2'], ['nothing', undefined]])('refuses %s', (_name, level) => {
    expect(thisSiteOf({ site: { level, unscored: false } })).toBeNull()
  })

  it('takes unscored only on Level 2', () => {
    expect(thisSiteOf({ site: { level: 3, unscored: true } })).toEqual({ level: 3, unscored: false })
  })
})
