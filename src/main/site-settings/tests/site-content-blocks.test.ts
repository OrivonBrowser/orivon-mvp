import { afterEach, describe, expect, it, vi } from 'vitest'
import { siteContentBlocks } from '../site-content-blocks.js'

afterEach(() => { siteContentBlocks.bind(() => false) })

describe('siteContentBlocks', () => {
  it('blocks nothing until a rule is bound', () => {
    expect(siteContentBlocks.blocked('https://a.example/')).toBe(false)
  })

  it('asks the bound rule about the page', () => {
    siteContentBlocks.bind((url) => url.startsWith('https://quiet.example'))
    expect(siteContentBlocks.blocked('https://quiet.example/x')).toBe(true)
    expect(siteContentBlocks.blocked('https://other.example/')).toBe(false)
  })

  it('treats a rule that throws as "not blocked" and logs it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    siteContentBlocks.bind(() => { throw new Error('store gone') })
    expect(siteContentBlocks.blocked('https://a.example/')).toBe(false)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('tells every listener about a change until it stops, and survives one that throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = vi.fn(() => { throw new Error('window closed') })
    const second = vi.fn()
    siteContentBlocks.onChange(first)
    const stop = siteContentBlocks.onChange(second)
    siteContentBlocks.changed()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    stop()
    siteContentBlocks.changed()
    expect(second).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})
