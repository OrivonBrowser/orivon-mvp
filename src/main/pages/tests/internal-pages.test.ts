import { describe, expect, it } from 'vitest'
import { INTERNAL_PAGES, internalUrl, isInternalPageId, parseInternalUrl } from '../internal-pages.js'

describe('parseInternalUrl', () => {
  it.each([
    ['orivon://settings', 'settings', '/'],
    ['orivon://settings/', 'settings', '/'],
    ['orivon://settings/privacy', 'settings', '/privacy'],
    ['  ORIVON://History/  ', 'history', '/'],
    ['orivon://settings/chains/1?x=2#top', 'settings', '/chains/1?x=2#top'],
    ['orivon://profiles', 'profiles', '/'],
    ['orivon://private', 'private', '/']
  ])('reads %s', (input, page, path) => {
    expect(parseInternalUrl(input)).toEqual({ page, path })
  })

  it.each([
    'https://settings/',
    'orivon://nope',
    'orivon://',
    'orivon://settings:8080/',
    'orivon://user@settings/',
    'orivon://user:pw@settings/',
    'orivon:settings',
    'settings',
    'javascript:orivon://settings',
    '',
    'not a url'
  ])('refuses %s', (input) => {
    expect(parseInternalUrl(input)).toBeNull()
  })

  it('names every page it can parse', () => {
    for (const page of INTERNAL_PAGES) expect(parseInternalUrl(internalUrl(page))?.page).toBe(page)
  })
})

describe('internalUrl', () => {
  it('builds the address of a page and of a place inside it', () => {
    expect(internalUrl('settings')).toBe('orivon://settings/')
    expect(internalUrl('settings', '/privacy')).toBe('orivon://settings/privacy')
    expect(internalUrl('settings', 'privacy')).toBe('orivon://settings/privacy')
  })
})

describe('isInternalPageId', () => {
  it('accepts a page and nothing else', () => {
    expect(isInternalPageId('history')).toBe(true)
    for (const value of ['', 'History', 'toString', '__proto__', 5, null, undefined]) expect(isInternalPageId(value)).toBe(false)
  })
})
