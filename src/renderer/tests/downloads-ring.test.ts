import { describe, expect, it } from 'vitest'
import type { DownloadsButtonState } from '../../main/shell/tab-types.js'
import { RING_LENGTH, buttonTitle, ringDash, ringMode } from '../chrome/downloads-ring.js'

const state = (over: Partial<DownloadsButtonState> = {}): DownloadsButtonState => ({ shown: true, active: 0, fraction: null, paused: false, attention: 'none', ...over })
const filled = (fraction: number | null): number => Number(ringDash(fraction).split(' ')[0])

describe('ringDash', () => {
  it('fills the ring in proportion to the share downloaded', () => {
    expect(filled(0.5)).toBeCloseTo(RING_LENGTH / 2, 1)
    expect(filled(1)).toBeCloseTo(RING_LENGTH, 1)
  })

  it('shows a sliver for a download that has only begun, and never more than the whole ring', () => {
    expect(filled(0)).toBeCloseTo(RING_LENGTH * 0.03, 1)
    expect(filled(7)).toBeCloseTo(RING_LENGTH, 1)
    expect(filled(-1)).toBeCloseTo(RING_LENGTH * 0.03, 1)
  })

  it('draws a quarter arc when the size is not known', () => {
    expect(filled(null)).toBeCloseTo(RING_LENGTH / 4, 1)
  })

  it('leaves a gap for the rest, so the dash never wraps', () => {
    const [on, off] = ringDash(0.4).split(' ').map(Number)
    expect((on ?? 0) + (off ?? 0)).toBeGreaterThan(RING_LENGTH)
  })
})

describe('ringMode', () => {
  it('has no ring with nothing running, fills when a size is known and turns when it is not', () => {
    expect(ringMode(state())).toBe('none')
    expect(ringMode(state({ active: 2, fraction: 0.4 }))).toBe('fill')
    expect(ringMode(state({ active: 1, fraction: null }))).toBe('turn')
  })
})

describe('buttonTitle', () => {
  it('names the downloads running and how far they are', () => {
    expect(buttonTitle(state({ active: 2, fraction: 0.45 }), 'Ctrl+J')).toBe('2 downloads, 45%')
    expect(buttonTitle(state({ active: 1, fraction: 0.004 }), 'Ctrl+J')).toBe('1 download, 0%')
  })

  it('says so when all of them are paused, and leaves the percentage out when the size is not known', () => {
    expect(buttonTitle(state({ active: 1, fraction: 0.3, paused: true }), 'Ctrl+J')).toBe('1 download paused, 30%')
    expect(buttonTitle(state({ active: 3, fraction: null }), 'Ctrl+J')).toBe('3 downloads')
  })

  it('names the button and its key when idle, and what wants a look when something does', () => {
    expect(buttonTitle(state(), 'Ctrl+J')).toBe('Downloads (Ctrl+J)')
    expect(buttonTitle(state({ attention: 'done' }), 'Ctrl+J')).toBe('Download finished (Ctrl+J)')
    expect(buttonTitle(state({ attention: 'warn' }), '⌘J')).toBe('A file is waiting for your answer (⌘J)')
    expect(buttonTitle(state({ attention: 'failed' }), 'Ctrl+J')).toBe('A download failed (Ctrl+J)')
  })
})
