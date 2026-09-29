import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearExtensionMatchLog,
  extensionIdsWithBadgeTextEnabled,
  getActionCount,
  getLoggedMatches,
  incrementActionCount,
  isDisplayActionCountAsBadgeTextEnabled,
  recordMatches,
  resetActionCountForTab,
  setDisplayActionCountAsBadgeText,
} from '../dnr-match-log.js'

// Every function here shares process-lifetime module state (no per-test
// reset hook exists, or is needed, outside tests -- clearExtensionMatchLog
// is the real, already-justified per-extension cleanup, the same one
// uninstall/disable call), so each test below either uses an id no other
// test in this file uses, or clears the ids it touched first.

describe('recordMatches / getLoggedMatches', () => {
  afterEach(() => {
    clearExtensionMatchLog('rec-a')
    clearExtensionMatchLog('rec-b')
  })

  it('logs nothing for an empty matchedRules array', () => {
    recordMatches(1, [])
    expect(getLoggedMatches('rec-a', undefined)).toEqual([])
  })

  it('logs one entry per matched rule, filterable by extensionId and tabId', () => {
    recordMatches(1, [{ extensionId: 'rec-a', rulesetId: '_session', ruleId: 1 }])
    recordMatches(2, [{ extensionId: 'rec-a', rulesetId: '_session', ruleId: 2 }])
    recordMatches(1, [{ extensionId: 'rec-b', rulesetId: '_session', ruleId: 3 }])

    const allForA = getLoggedMatches('rec-a', undefined)
    expect(allForA).toHaveLength(2)
    expect(allForA.map((entry) => entry.info.ruleId).sort()).toEqual([1, 2])

    const tab1ForA = getLoggedMatches('rec-a', 1)
    expect(tab1ForA).toHaveLength(1)
    expect(tab1ForA[0]?.info.ruleId).toBe(1)

    expect(getLoggedMatches('rec-b', undefined)).toHaveLength(1)
  })

  it('prunes an entry older than the 5-minute TTL on the next read', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      recordMatches(1, [{ extensionId: 'rec-a', rulesetId: '_session', ruleId: 1 }])
      expect(getLoggedMatches('rec-a', undefined)).toHaveLength(1)

      vi.setSystemTime(5 * 60 * 1000 + 1)
      expect(getLoggedMatches('rec-a', undefined)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('badge-count mode', () => {
  afterEach(() => {
    clearExtensionMatchLog('badge-a')
    clearExtensionMatchLog('badge-b')
  })

  it('is off by default, and reflects the last value set', () => {
    expect(isDisplayActionCountAsBadgeTextEnabled('badge-a')).toBe(false)
    setDisplayActionCountAsBadgeText('badge-a', true)
    expect(isDisplayActionCountAsBadgeTextEnabled('badge-a')).toBe(true)
    setDisplayActionCountAsBadgeText('badge-a', false)
    expect(isDisplayActionCountAsBadgeTextEnabled('badge-a')).toBe(false)
  })

  it('extensionIdsWithBadgeTextEnabled lists only the extensions currently on', () => {
    setDisplayActionCountAsBadgeText('badge-a', true)
    setDisplayActionCountAsBadgeText('badge-b', false)
    expect(extensionIdsWithBadgeTextEnabled()).toContain('badge-a')
    expect(extensionIdsWithBadgeTextEnabled()).not.toContain('badge-b')
  })
})

describe('action counts', () => {
  afterEach(() => {
    clearExtensionMatchLog('count-a')
    clearExtensionMatchLog('count-b')
  })

  it('starts at 0 for a never-incremented (extension, tab) pair', () => {
    expect(getActionCount('count-a', 1)).toBe(0)
  })

  it('accumulates increments per (extension, tab), independently of other tabs and extensions', () => {
    incrementActionCount('count-a', 1, 1)
    incrementActionCount('count-a', 1, 1)
    incrementActionCount('count-a', 2, 1)
    incrementActionCount('count-b', 1, 1)

    expect(getActionCount('count-a', 1)).toBe(2)
    expect(getActionCount('count-a', 2)).toBe(1)
    expect(getActionCount('count-b', 1)).toBe(1)
  })

  it('resetActionCountForTab zeroes every extension\'s count for that tab, leaves other tabs untouched', () => {
    incrementActionCount('count-a', 1, 3)
    incrementActionCount('count-b', 1, 5)
    incrementActionCount('count-a', 2, 7)

    resetActionCountForTab(1)

    expect(getActionCount('count-a', 1)).toBe(0)
    expect(getActionCount('count-b', 1)).toBe(0)
    expect(getActionCount('count-a', 2)).toBe(7)
  })

  it('resetActionCountForTab does not confuse tab 1 with tab 21 (or any other numeric-suffix collision)', () => {
    incrementActionCount('count-a', 21, 9)
    resetActionCountForTab(1)
    expect(getActionCount('count-a', 21)).toBe(9)
  })
})

describe('clearExtensionMatchLog', () => {
  it('clears one extension\'s matches, badge flag and counts, leaves other extensions alone', () => {
    recordMatches(1, [{ extensionId: 'clear-a', rulesetId: '_session', ruleId: 1 }])
    recordMatches(1, [{ extensionId: 'clear-b', rulesetId: '_session', ruleId: 2 }])
    setDisplayActionCountAsBadgeText('clear-a', true)
    setDisplayActionCountAsBadgeText('clear-b', true)
    incrementActionCount('clear-a', 1, 4)
    incrementActionCount('clear-b', 1, 4)

    clearExtensionMatchLog('clear-a')

    expect(getLoggedMatches('clear-a', undefined)).toEqual([])
    expect(isDisplayActionCountAsBadgeTextEnabled('clear-a')).toBe(false)
    expect(getActionCount('clear-a', 1)).toBe(0)

    expect(getLoggedMatches('clear-b', undefined)).toHaveLength(1)
    expect(isDisplayActionCountAsBadgeTextEnabled('clear-b')).toBe(true)
    expect(getActionCount('clear-b', 1)).toBe(4)

    clearExtensionMatchLog('clear-b')
  })
})
