import { describe, expect, it, vi } from 'vitest'
import { baseManifestOr, createBaseManifestCache, setBaseManifestSource } from '../base-manifest-source.js'

describe('createBaseManifestCache', () => {
  it('reads an extension once until it is invalidated', () => {
    const readText = vi.fn(() => '{"name":"x"}')
    const cache = createBaseManifestCache({ readText })
    expect(cache.baseOf('a')).toEqual({ name: 'x' })
    expect(cache.baseOf('a')).toEqual({ name: 'x' })
    expect(readText).toHaveBeenCalledTimes(1)
    cache.invalidate('a')
    cache.baseOf('a')
    expect(readText).toHaveBeenCalledTimes(2)
  })

  it('does not remember a missing or broken file', () => {
    let text: string | undefined
    const cache = createBaseManifestCache({ readText: () => text })
    expect(cache.baseOf('a')).toBeUndefined()
    text = '{nope'
    expect(cache.baseOf('a')).toBeUndefined()
    text = '[1]'
    expect(cache.baseOf('a')).toBeUndefined()
    text = '{"name":"y"}'
    expect(cache.baseOf('a')).toEqual({ name: 'y' })
  })
})

describe('baseManifestOr', () => {
  it('falls back to the loaded manifest until a source is set', () => {
    expect(baseManifestOr('a', { loaded: true })).toEqual({ loaded: true })
    setBaseManifestSource(() => ({ base: true }))
    expect(baseManifestOr('a', { loaded: true })).toEqual({ base: true })
    setBaseManifestSource(undefined)
  })
})
