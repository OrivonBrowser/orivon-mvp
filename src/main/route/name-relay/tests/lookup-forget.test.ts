// How "Clear browsing data" reaches the relay's lookups: whoever runs them registers the way to forget, and nothing happens where none run.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetNameLookups, setNameLookupForgetter } from '../lookup-forget.js'

afterEach(() => { setNameLookupForgetter(undefined) })

describe('forgetting the relay\'s lookups', () => {
  it('does nothing where no lookups run', () => {
    expect(() => { forgetNameLookups() }).not.toThrow()
  })

  it('calls what whoever runs them registered, and nothing once it is taken away', () => {
    const forget = vi.fn()
    setNameLookupForgetter(forget)
    forgetNameLookups()
    expect(forget).toHaveBeenCalledTimes(1)
    setNameLookupForgetter(undefined)
    forgetNameLookups()
    expect(forget).toHaveBeenCalledTimes(1)
  })
})
