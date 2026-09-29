import { describe, expect, it } from 'vitest'
import { previewSizeFor } from '../tear-drag.js'

// Only the pure sizing rule: the controller itself drives real BaseWindow/
// WebContentsView/screen calls, covered by the real-XTest verification run
// instead (docs cited in the PR), not a unit test double of Electron.
describe('previewSizeFor', () => {
  it('is about a third of the source window, keeping its aspect ratio', () => {
    const size = previewSizeFor(1200, 800)
    expect(size.width).toBe(400)
    expect(size.height).toBe(Math.round(400 * 800 / 1200))
  })

  it('never exceeds the cap, even for a very wide window', () => {
    const size = previewSizeFor(3840, 2160)
    expect(size.width).toBe(480)
  })

  it('never produces a zero-sized preview for a degenerate window', () => {
    const size = previewSizeFor(0, 0)
    expect(size.width).toBeGreaterThan(0)
    expect(size.height).toBeGreaterThan(0)
  })
})
