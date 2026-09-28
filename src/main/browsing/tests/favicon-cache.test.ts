import { describe, expect, it } from 'vitest'
import { FaviconCache } from '../favicon-cache.js'

describe('FaviconCache', () => {
  it('returns what was stored, and undefined for anything else', () => {
    const cache = new FaviconCache(4, 100)
    cache.set('a', 'data:a')
    expect(cache.get('a')).toBe('data:a')
    expect(cache.get('b')).toBeUndefined()
  })

  it('drops the least recently used entry once past its entry count', () => {
    const cache = new FaviconCache(2, 1000)
    cache.set('a', 'data:a')
    cache.set('b', 'data:b')
    cache.set('c', 'data:c')
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('data:b')
    expect(cache.get('c')).toBe('data:c')
  })

  it('counts a read as a use', () => {
    const cache = new FaviconCache(2, 1000)
    cache.set('a', 'data:a')
    cache.set('b', 'data:b')
    cache.get('a')
    cache.set('c', 'data:c')
    expect(cache.get('a')).toBe('data:a')
    expect(cache.get('b')).toBeUndefined()
  })

  it('drops the least recently used entries once past its size, however few entries there are', () => {
    const cache = new FaviconCache(100, 10)
    cache.set('a', 'xxxx')
    cache.set('b', 'yyyy')
    cache.set('c', 'zzzz')
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('yyyy')
    expect(cache.get('c')).toBe('zzzz')
  })

  it('never stores a value larger than its whole size, and keeps what it had', () => {
    const cache = new FaviconCache(100, 10)
    cache.set('a', 'xxxx')
    cache.set('huge', 'x'.repeat(11))
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.get('a')).toBe('xxxx')
  })

  it('counts a replaced value once, not twice', () => {
    const cache = new FaviconCache(100, 10)
    cache.set('a', 'xxxxxx')
    cache.set('a', 'yyyyyy')
    cache.set('b', 'zzzz')
    expect(cache.get('a')).toBe('yyyyyy')
    expect(cache.get('b')).toBe('zzzz')
  })
})
