import { describe, expect, it } from 'vitest'
import { summaryAtLevel } from '../grant-level.js'
import type { CapabilityGrantSummary } from '../grant-prompt-connect.js'

// ADR-0037: an L4 site's grants carry no warnings, on every consent
// surface -- one rule, applied at row-building time, so every caller
// (dialogs, the site-info popup, the all-sites panel) gets it identically
// rather than each re-deriving its own "is this L4" branch.

describe('summaryAtLevel', () => {
  it('returns the same object, unchanged, at every level short of 4', () => {
    const summary: CapabilityGrantSummary = { warning: true, message: '⚠ Unlimited network access', explanation: 'reach anywhere' }
    for (const level of [1, 2, 3, undefined] as const) {
      expect(summaryAtLevel(summary, level)).toBe(summary)
    }
  })

  it('at level 4, strips the warning: no warning flag, no explanation, no leading glyph', () => {
    const summary: CapabilityGrantSummary = { warning: true, message: '⚠ Unlimited network access', explanation: 'reach anywhere' }
    expect(summaryAtLevel(summary, 4)).toEqual({ warning: false, message: 'Unlimited network access' })
  })

  it('strips the glyph from every line of a multi-line message (web.context, one origin per line)', () => {
    const summary: CapabilityGrantSummary = {
      warning: true,
      message: '⚠ Run code as a.example, in a private, empty session.\n⚠ Run code as b.example, in a private, empty session.',
      explanation: 'It cannot see your account or anything you keep there.'
    }
    expect(summaryAtLevel(summary, 4)).toEqual({
      warning: false,
      message: 'Run code as a.example, in a private, empty session.\nRun code as b.example, in a private, empty session.'
    })
  })

  it('a row with no warning at all is unchanged at level 4 too', () => {
    const summary: CapabilityGrantSummary = { warning: false, message: 'Store files in a private folder for this app on this device' }
    expect(summaryAtLevel(summary, 4)).toEqual(summary)
  })

  it('never leaves an explanation behind once the warning it explained is gone', () => {
    const summary: CapabilityGrantSummary = { warning: true, message: '⚠ Accepts connections and data from other computers on port 443', explanation: 'This opens a door into your device.' }
    const result = summaryAtLevel(summary, 4)
    expect(result.explanation).toBeUndefined()
  })
})
