import { describe, expect, it } from 'vitest'
import { SETTINGS, validateSetting } from '../../settings/schema.js'
import { SITE_KINDS, siteKindById } from '../kinds.js'

describe('SITE_KINDS', () => {
  it('lists each kind once', () => {
    const ids = SITE_KINDS.map((kind) => kind.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(15)
  })

  it.each(SITE_KINDS.map((kind) => [kind.id, kind] as const))('%s is backed by a setting with the same choices and default', (_id, kind) => {
    const spec = SETTINGS[kind.settingKey]
    expect(spec.kind).toBe('enum')
    if (spec.kind !== 'enum') return
    expect(spec.options).toEqual(kind.values)
    expect(spec.default).toBe(kind.values[0])
    expect(validateSetting(spec, kind.values[0])).toBe(kind.values[0])
  })

  it('gives every kind its own setting key', () => {
    const keys = SITE_KINDS.map((kind) => kind.settingKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('marks no kind available until its feature enforces it', () => {
    expect(SITE_KINDS.filter((kind) => kind.available)).toEqual([])
  })

  it('finds a kind by id and answers undefined for anything else', () => {
    expect(siteKindById('camera')?.label).toBe('Camera')
    expect(siteKindById('toString')).toBeUndefined()
    expect(siteKindById(3)).toBeUndefined()
  })
})
