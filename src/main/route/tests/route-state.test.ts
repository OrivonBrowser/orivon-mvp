import { describe, expect, it } from 'vitest'
import { entryFor, tunnelStateOf } from '../route-state.js'

describe('the tunnel state of an origin', () => {
  it('follows the default when the origin has no entry', () => {
    expect(tunnelStateOf(undefined, false)).toBe('off')
    expect(tunnelStateOf(undefined, true)).toBe('on')
  })

  it('takes its own entry over the default, either way', () => {
    expect(tunnelStateOf('on', false)).toBe('on')
    expect(tunnelStateOf('off', true)).toBe('off')
    expect(tunnelStateOf('on', true)).toBe('on')
    expect(tunnelStateOf('off', false)).toBe('off')
  })
})

describe('the entry that makes a website on or off', () => {
  it('is none when the default already says so, so the website goes back to the default session', () => {
    expect(entryFor('off', false)).toBeUndefined()
    expect(entryFor('on', true)).toBeUndefined()
  })

  it('is the state itself when it differs from the default', () => {
    expect(entryFor('on', false)).toBe('on')
    expect(entryFor('off', true)).toBe('off')
  })
})
