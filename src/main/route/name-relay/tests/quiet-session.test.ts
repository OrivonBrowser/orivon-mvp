// A relay session takes the spell checker off before its first request.

import { describe, expect, it, vi } from 'vitest'
import { quietSession } from '../quiet-session.js'

describe('quietSession', () => {
  it('turns the spell checker off and gives it no language, and hands the same session back', () => {
    const session = { setSpellCheckerEnabled: vi.fn(), setSpellCheckerLanguages: vi.fn() }
    expect(quietSession(session)).toBe(session)
    expect(session.setSpellCheckerEnabled).toHaveBeenCalledExactlyOnceWith(false)
    expect(session.setSpellCheckerLanguages).toHaveBeenCalledExactlyOnceWith([])
  })
})
