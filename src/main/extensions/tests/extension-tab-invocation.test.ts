import { describe, expect, it } from 'vitest'
import { clearInvocationsForExtension, clearInvocation, hasRecentInvocation, recordInvocation } from '../extension-tab-invocation.js'

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

  describe('clearInvocationsForExtension', () => {
    it('revokes every tab grant for the given extension, regardless of which tab', () => {
      recordInvocation('ext-k1', 1)
      recordInvocation('ext-k1', 2)
      recordInvocation('ext-k1', 3)
      clearInvocationsForExtension('ext-k1')
      expect(hasRecentInvocation('ext-k1', 1)).toBe(false)
      expect(hasRecentInvocation('ext-k1', 2)).toBe(false)
      expect(hasRecentInvocation('ext-k1', 3)).toBe(false)
    })

    it('never touches a different extension\'s grant, even on the same tab', () => {
      recordInvocation('ext-k2', 1)
      recordInvocation('ext-k3', 1)
      clearInvocationsForExtension('ext-k2')
      expect(hasRecentInvocation('ext-k2', 1)).toBe(false)
      expect(hasRecentInvocation('ext-k3', 1)).toBe(true)
    })

    it('is a harmless no-op for an extension with no grants at all', () => {
      expect(() => { clearInvocationsForExtension('ext-k-never') }).not.toThrow()
    })
  })
})
