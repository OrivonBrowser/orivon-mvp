import { describe, expect, it, vi } from 'vitest'
import { createSiteAsks, type SiteAsker } from '../site-asks.js'

const TAB = { id: 1 } as never

describe('createSiteAsks', () => {
  it('answers undefined while no asker is registered', () => {
    const asks = createSiteAsks()
    expect(asks.request(TAB, 'media', {})).toBeUndefined()
    expect(asks.check(TAB, 'media', 'https://a.example', {})).toBeUndefined()
  })

  it('returns the first answer that is not undefined, in registration order', async () => {
    const asks = createSiteAsks()
    asks.add({ name: 'skips', request: () => undefined, check: () => undefined })
    asks.add({ name: 'first', request: async () => await Promise.resolve(false), check: () => false })
    asks.add({ name: 'second', request: async () => await Promise.resolve(true), check: () => true })
    expect(await asks.request(TAB, 'media', {})).toBe(false)
    expect(asks.check(TAB, 'media', 'https://a.example', {})).toBe(false)
  })

  it('passes the contents, permission, origin and details through unchanged', () => {
    const check = vi.fn<NonNullable<SiteAsker['check']>>(() => true)
    const asks = createSiteAsks()
    asks.add({ name: 'spy', check })
    const details = { embeddingOrigin: 'https://top.example' }
    asks.check(null, 'geolocation', 'https://a.example', details)
    expect(check).toHaveBeenCalledWith(null, 'geolocation', 'https://a.example', details)
  })

  it('logs a throwing asker by name and lets the next one answer', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const asks = createSiteAsks()
      asks.add({ name: 'broken', check: () => { throw new Error('boom') } })
      asks.add({ name: 'fine', check: () => false })
      expect(asks.check(TAB, 'midi', 'https://a.example', {})).toBe(false)
      expect(error.mock.calls[0]?.[0]).toContain('broken')
    } finally {
      error.mockRestore()
    }
  })

  it('falls through, not allows, when the only asker throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const asks = createSiteAsks()
      asks.add({ name: 'broken', request: () => { throw new Error('boom') } })
      expect(asks.request(TAB, 'midi', {})).toBeUndefined()
    } finally {
      error.mockRestore()
    }
  })

  it('asks an asker added first before every asker registered earlier', async () => {
    const asks = createSiteAsks()
    asks.add({ name: 'general', request: async () => await Promise.resolve(true), check: () => true })
    asks.addFirst({ name: 'owner', request: async () => await Promise.resolve(false), check: () => false })
    expect(await asks.request(TAB, 'media', {})).toBe(false)
    expect(asks.check(TAB, 'display-capture', 'https://a.example', {})).toBe(false)
  })

  it('lets the general asker answer when the one added first answers undefined', async () => {
    const asks = createSiteAsks()
    asks.add({ name: 'general', request: async () => await Promise.resolve(true) })
    asks.addFirst({ name: 'owner', request: () => undefined })
    expect(await asks.request(TAB, 'media', {})).toBe(true)
  })

  it('tells every asker that a request was granted, and skips one that throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const heard = vi.fn()
      const asks = createSiteAsks()
      asks.add({ name: 'broken', afterGrant: () => { throw new Error('boom') } })
      asks.add({ name: 'silent' })
      asks.add({ name: 'listener', afterGrant: heard })
      const details = { mediaTypes: [] }
      asks.afterGrant(TAB, 'media', details)
      expect(heard).toHaveBeenCalledWith(TAB, 'media', details)
      expect(error.mock.calls[0]?.[0]).toContain('broken')
    } finally {
      error.mockRestore()
    }
  })
})
