import { describe, expect, it } from 'vitest'
import { clearInvocation, hasRecentInvocation, recordInvocation } from '../extension-tab-invocation.js'

describe('extension-tab-invocation', () => {
  it('has no invocation before one is recorded', () => {
    expect(hasRecentInvocation('ext-a', 1)).toBe(false)
  })

  it('grants after recordInvocation, scoped to the exact (extension, tab) pair', () => {
    recordInvocation('ext-a', 1)
    expect(hasRecentInvocation('ext-a', 1)).toBe(true)
    expect(hasRecentInvocation('ext-a', 2)).toBe(false)
    expect(hasRecentInvocation('ext-b', 1)).toBe(false)
  })

  it('clearInvocation revokes it', () => {
    recordInvocation('ext-a', 1)
    clearInvocation('ext-a', 1)
    expect(hasRecentInvocation('ext-a', 1)).toBe(false)
  })

  it('clearInvocation for one tab never revokes another extension\'s grant on the same tab', () => {
    recordInvocation('ext-a', 1)
    recordInvocation('ext-b', 1)
    clearInvocation('ext-a', 1)
    expect(hasRecentInvocation('ext-a', 1)).toBe(false)
    expect(hasRecentInvocation('ext-b', 1)).toBe(true)
  })

  it('clearing an invocation that was never granted is a harmless no-op', () => {
    expect(() => { clearInvocation('ext-never', 99) }).not.toThrow()
  })
})
