import { afterEach, describe, expect, it, vi } from 'vitest'
import { siteSound } from '../site-sound.js'

afterEach(() => { siteSound.bind(() => false) })

describe('siteSound', () => {
  it('silences nothing until a rule is bound', () => {
    expect(siteSound.blocked('https://a.example/')).toBe(false)
  })

  it('asks the bound rule about the page', () => {
    siteSound.bind((url) => url.startsWith('https://loud.example'))
    expect(siteSound.blocked('https://loud.example/x')).toBe(true)
    expect(siteSound.blocked('https://calm.example/')).toBe(false)
  })

  it('treats a rule that throws as "not silenced" and logs it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    siteSound.bind(() => { throw new Error('store gone') })
    expect(siteSound.blocked('https://a.example/')).toBe(false)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
