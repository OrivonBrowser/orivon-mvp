import { describe, expect, it } from 'vitest'
import { differsFromDefault, tunnelStateOf } from '../route-state.js'

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

describe('whether a website needs storage of its own', () => {
  it('does when its state differs from the default', () => {
    expect(differsFromDefault('on', false)).toBe(true)
    expect(differsFromDefault('off', true)).toBe(true)
  })

  it('does not when it has no entry, or an entry the default already says', () => {
    expect(differsFromDefault(undefined, false)).toBe(false)
    expect(differsFromDefault(undefined, true)).toBe(false)
    expect(differsFromDefault('off', false)).toBe(false)
    expect(differsFromDefault('on', true)).toBe(false)
  })
})
