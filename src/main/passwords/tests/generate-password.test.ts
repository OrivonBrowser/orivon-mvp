import { describe, expect, it } from 'vitest'
import { generatePassword, PASSWORD_LENGTH } from '../generate-password.js'

describe('generatePassword', () => {
  it('is 20 characters by default', () => {
    expect(generatePassword()).toHaveLength(PASSWORD_LENGTH)
    expect(PASSWORD_LENGTH).toBe(20)
  })

  it('always holds a lower-case letter, a capital, a digit and a symbol, and never a look-alike', () => {
    for (let i = 0; i < 500; i++) {
      const password = generatePassword()
      expect(password).toMatch(/[a-z]/)
      expect(password).toMatch(/[A-Z]/)
      expect(password).toMatch(/[0-9]/)
      expect(password).toMatch(/[-_.!]/)
      expect(password).toMatch(/^[a-zA-Z0-9\-_.!]+$/)
      expect(password).not.toMatch(/[0O1lI]/)
    }
  })

  it('holds the four classes at the shortest length too', () => {
    for (let i = 0; i < 100; i++) expect(generatePassword(4)).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[2-9])(?=.*[-_.!]).{4}$/)
  })

  it('differs from call to call', () => {
    expect(new Set(Array.from({ length: 50 }, () => generatePassword())).size).toBe(50)
  })

  it('draws every character from the random source it is given', () => {
    const calls: number[] = []
    const password = generatePassword(6, (max) => { calls.push(max); return 0 })
    expect(password).toHaveLength(6)
    expect(calls.every((max) => max > 0)).toBe(true)
  })

  it('refuses a length that cannot hold the classes or is unreasonable', () => {
    for (const bad of [0, 3, 129, 1.5, Number.NaN]) expect(() => generatePassword(bad), String(bad)).toThrow(RangeError)
  })
})
