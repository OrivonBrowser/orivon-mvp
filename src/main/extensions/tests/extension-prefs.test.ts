import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXTENSION_PREFS, mergePrefs, normalizePrefs, parsePrefsFile, serializePrefs, PREFS_FILE_VERSION
} from '../extension-prefs.js'

describe('normalizePrefs', () => {
  it('gives the defaults for nothing, for a non-object and for an empty object', () => {
    for (const raw of [undefined, null, 'x', 4, [], {}]) expect(normalizePrefs(raw)).toEqual(DEFAULT_EXTENSION_PREFS)
  })

  it('has the documented defaults', () => {
    expect(DEFAULT_EXTENSION_PREFS).toEqual({
      pinned: null,
      granted: { permissions: [], origins: [] },
      siteAccess: { mode: 'all', sites: [] },
      shortcuts: {},
      overrides: { newtab: true, history: true, bookmarks: true },
      noticeSeen: []
    })
  })

  it('keeps a good field and defaults only the bad one', () => {
    const prefs = normalizePrefs({
      pinned: true,
      granted: { permissions: ['history', 4, 'history', ''], origins: 'nope' },
      siteAccess: { mode: 'sometimes', sites: ['https://a.example/*'] },
      shortcuts: { run: 'Ctrl+Shift+Y', other: 3, cleared: '' },
      overrides: { newtab: false, history: 'no' },
      noticeSeen: ['a', 'a', 9]
    })
    expect(prefs.pinned).toBe(true)
    expect(prefs.granted).toEqual({ permissions: ['history'], origins: [] })
    expect(prefs.siteAccess).toEqual({ mode: 'all', sites: ['https://a.example/*'] })
    expect(prefs.shortcuts).toEqual({ run: 'Ctrl+Shift+Y', cleared: '' })
    expect(prefs.overrides).toEqual({ newtab: false, history: true, bookmarks: true })
    expect(prefs.noticeSeen).toEqual(['a'])
  })

  it('takes the three site-access modes', () => {
    for (const mode of ['all', 'sites', 'click']) expect(normalizePrefs({ siteAccess: { mode } }).siteAccess.mode).toBe(mode)
  })

  it('returns a frozen record', () => {
    const prefs = normalizePrefs({ granted: { permissions: ['x'] } })
    expect(Object.isFrozen(prefs)).toBe(true)
    expect(Object.isFrozen(prefs.granted)).toBe(true)
    expect(Object.isFrozen(prefs.granted.permissions)).toBe(true)
  })
})

describe('mergePrefs', () => {
  it('replaces the named top-level fields and keeps the rest', () => {
    const merged = mergePrefs(normalizePrefs({ pinned: true }), { siteAccess: { mode: 'click', sites: [] } })
    expect(merged.pinned).toBe(true)
    expect(merged.siteAccess.mode).toBe('click')
  })

  it('normalises a bad patch field back to its default and ignores an unknown one', () => {
    const merged = mergePrefs(DEFAULT_EXTENSION_PREFS, { siteAccess: { mode: 'bogus' as 'all', sites: [] }, extra: 1 } as never)
    expect(merged).toEqual(DEFAULT_EXTENSION_PREFS)
  })

  it('lets pinned go back to following the setting', () => {
    expect(mergePrefs(normalizePrefs({ pinned: false }), { pinned: null }).pinned).toBeNull()
  })
})

describe('parsePrefsFile and serializePrefs', () => {
  it('round-trips only what differs from the defaults', () => {
    const records = new Map([
      ['aaa', normalizePrefs({ pinned: false })],
      ['bbb', DEFAULT_EXTENSION_PREFS]
    ])
    const parsed = parsePrefsFile(serializePrefs(records))
    expect([...parsed.keys()]).toEqual(['aaa'])
    expect(parsed.get('aaa')?.pinned).toBe(false)
  })

  it('reads nothing from a file that is not JSON, the wrong version or the wrong shape', () => {
    expect(parsePrefsFile('{nope').size).toBe(0)
    expect(parsePrefsFile(JSON.stringify({ version: 99, extensions: { a: {} } })).size).toBe(0)
    expect(parsePrefsFile(JSON.stringify({ version: PREFS_FILE_VERSION, extensions: [] })).size).toBe(0)
  })

  it('drops an extension whose record is not an object and keeps the others', () => {
    const text = JSON.stringify({ version: PREFS_FILE_VERSION, extensions: { a: 'x', b: { pinned: true }, c: null } })
    expect([...parsePrefsFile(text).keys()]).toEqual(['b'])
  })

  it('keeps an id that is a prototype name as an ordinary key', () => {
    const text = '{"version":1,"extensions":{"__proto__":{"pinned":true},"constructor":{"pinned":false}}}'
    expect(parsePrefsFile(text).get('constructor')?.pinned).toBe(false)
  })
})
