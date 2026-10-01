import { describe, expect, it, vi } from 'vitest'
import { memoryVault } from '../vault.js'

const SITE = 'https://shop.example'

describe('memoryVault', () => {
  it('saves a login, lists it without its password and reveals the password by id', async () => {
    const vault = memoryVault()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'secret-1' })
    expect(login).toMatchObject({ origin: SITE, username: 'ada', used: 0 })
    expect(vault.list()).toEqual([login])
    expect(JSON.stringify(vault.list())).not.toContain('secret-1')
    expect(await vault.reveal(login?.id ?? '')).toBe('secret-1')
  })

  it('replaces the password of the same origin and username instead of adding a second login', async () => {
    const vault = memoryVault()
    const first = await vault.save({ origin: SITE, username: 'ada', password: 'one' })
    const second = await vault.save({ origin: SITE, username: 'ada', password: 'two' })
    expect(second?.id).toBe(first?.id)
    expect(vault.list()).toHaveLength(1)
    expect(await vault.reveal(first?.id ?? '')).toBe('two')
    await vault.save({ origin: SITE, username: 'grace', password: 'three' })
    expect(vault.list(SITE)).toHaveLength(2)
    expect(vault.list('https://other.example')).toEqual([])
  })

  it('refuses an origin that is not an origin and an empty password', async () => {
    const vault = memoryVault()
    expect(await vault.save({ origin: `${SITE}/login`, username: 'ada', password: 'x' })).toBeNull()
    expect(await vault.save({ origin: 'file:///etc', username: 'ada', password: 'x' })).toBeNull()
    expect(await vault.save({ origin: SITE, username: 'ada', password: '' })).toBeNull()
    expect(vault.list()).toEqual([])
  })

  it('touch records when a login was used, without changing the password, and ignores an unknown id', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(5000)
      const vault = memoryVault()
      const login = await vault.save({ origin: SITE, username: 'ada', password: 'x' })
      const heard = vi.fn()
      vault.onChange(heard)
      vault.touch?.(login?.id ?? '')
      expect(vault.list()[0]?.used).toBe(5000)
      expect(await vault.reveal(login?.id ?? '')).toBe('x')
      expect(heard).toHaveBeenCalledTimes(1)
      vault.touch?.('nope')
      expect(heard).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes a login and says whether there was one', async () => {
    const vault = memoryVault()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'x' })
    expect(await vault.remove(login?.id ?? '')).toBe(true)
    expect(await vault.remove(login?.id ?? '')).toBe(false)
    expect(await vault.reveal(login?.id ?? '')).toBeUndefined()
  })

  it('keeps a never-save list of origins', () => {
    const vault = memoryVault()
    vault.never.add(SITE)
    vault.never.add(`${SITE}/path`)
    expect(vault.never.has(SITE)).toBe(true)
    expect(vault.never.list()).toEqual([SITE])
    vault.never.remove(SITE)
    expect(vault.never.has(SITE)).toBe(false)
  })

  it('tells a listener about each change until it unsubscribes', async () => {
    const vault = memoryVault()
    const listener = vi.fn()
    const off = vault.onChange(listener)
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'x' })
    vault.never.add('https://a.example')
    vault.remove(login?.id ?? '')
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    await vault.save({ origin: SITE, username: 'ada', password: 'y' })
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it.each(['unavailable', 'private'] as const)('keeps nothing in the %s state', async (state) => {
    const vault = memoryVault(state)
    expect(vault.state()).toBe(state)
    expect(await vault.save({ origin: SITE, username: 'ada', password: 'x' })).toBeNull()
    vault.never.add(SITE)
    expect(vault.list()).toEqual([])
    expect(vault.never.list()).toEqual([])
  })
})
