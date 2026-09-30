import { describe, expect, it } from 'vitest'
import { createRateLimiter, MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, parseFormMessage } from '../form-message.js'

const rect = { x: 10, y: 20, width: 200, height: 30 }

describe('parseFormMessage', () => {
  it('reads each message the watcher sends', () => {
    expect(parseFormMessage({ type: 'hello' })).toEqual({ type: 'hello' })
    expect(parseFormMessage({ type: 'blur' })).toEqual({ type: 'blur' })
    expect(parseFormMessage({ type: 'fields', hasPassword: true, signUp: false })).toEqual({ type: 'fields', hasPassword: true, signUp: false })
    expect(parseFormMessage({ type: 'focus', rect, viewWidth: 1200, signUp: true })).toEqual({ type: 'focus', rect, viewWidth: 1200, signUp: true })
    expect(parseFormMessage({ type: 'submit', username: 'ada', password: 'pw' })).toEqual({ type: 'submit', username: 'ada', password: 'pw' })
  })

  it('keeps only the fields it knows', () => {
    expect(parseFormMessage({ type: 'hello', origin: 'https://evil.example' })).toEqual({ type: 'hello' })
    expect(parseFormMessage({ type: 'submit', username: 'a', password: 'b', origin: 'https://evil.example' })).toEqual({ type: 'submit', username: 'a', password: 'b' })
  })

  it('refuses anything that is not an object with a known type', () => {
    for (const value of [null, undefined, 'hello', 7, [], { type: 'nope' }, { type: 3 }, {}]) expect(parseFormMessage(value)).toBeNull()
  })

  it('refuses a field of the wrong type', () => {
    expect(parseFormMessage({ type: 'fields', hasPassword: 'yes', signUp: false })).toBeNull()
    expect(parseFormMessage({ type: 'fields', hasPassword: true })).toBeNull()
    expect(parseFormMessage({ type: 'submit', username: 1, password: 'x' })).toBeNull()
    expect(parseFormMessage({ type: 'submit', username: 'a', password: null })).toBeNull()
  })

  it('refuses an empty password and oversize strings', () => {
    expect(parseFormMessage({ type: 'submit', username: 'a', password: '' })).toBeNull()
    expect(parseFormMessage({ type: 'submit', username: 'a'.repeat(MAX_USERNAME_LENGTH + 1), password: 'x' })).toBeNull()
    expect(parseFormMessage({ type: 'submit', username: 'a', password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) })).toBeNull()
    expect(parseFormMessage({ type: 'submit', username: 'a'.repeat(MAX_USERNAME_LENGTH), password: 'x'.repeat(MAX_PASSWORD_LENGTH) })).not.toBeNull()
  })

  it('refuses a rectangle that is not finite numbers, or is far past any screen, and a width that is not a width', () => {
    expect(parseFormMessage({ type: 'focus', rect: { ...rect, x: Number.NaN }, viewWidth: 1, signUp: false })).toBeNull()
    expect(parseFormMessage({ type: 'focus', rect: { ...rect, y: Infinity }, viewWidth: 1, signUp: false })).toBeNull()
    expect(parseFormMessage({ type: 'focus', rect: { ...rect, width: 1e9 }, viewWidth: 1, signUp: false })).toBeNull()
    expect(parseFormMessage({ type: 'focus', rect: { x: 1, y: 1, width: '2', height: 3 }, viewWidth: 1, signUp: false })).toBeNull()
    expect(parseFormMessage({ type: 'focus', rect, viewWidth: 0, signUp: false })).toBeNull()
    expect(parseFormMessage({ type: 'focus', rect, viewWidth: -5, signUp: false })).toBeNull()
    expect(parseFormMessage({ type: 'focus', rect, viewWidth: 1200, signUp: 'no' })).toBeNull()
  })
})

describe('createRateLimiter', () => {
  it('lets a key send its limit in a window and refuses the rest', () => {
    let now = 0
    const allow = createRateLimiter(3, 1000, () => now)
    expect([allow(1), allow(1), allow(1), allow(1), allow(1)]).toEqual([true, true, true, false, false])
  })

  it('counts each key on its own', () => {
    const allow = createRateLimiter(1, 1000, () => 0)
    expect([allow(1), allow(2), allow(1), allow(2)]).toEqual([true, true, false, false])
  })

  it('starts again when the window has passed', () => {
    let now = 0
    const allow = createRateLimiter(1, 1000, () => now)
    expect(allow(1)).toBe(true)
    now = 999
    expect(allow(1)).toBe(false)
    now = 1000
    expect(allow(1)).toBe(true)
  })

  it('forgets keys whose window is over, so a long session holds no entry per tab ever opened', () => {
    let now = 0
    const allow = createRateLimiter(1, 1000, () => now)
    for (let key = 0; key < 300; key++) allow(key)
    now = 5000
    allow(1000)
    expect(allow(3)).toBe(true)
  })
})
