import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../window-registry.js'
import { parseStripBoxes, refreshStripLayouts, stripCentresFor } from '../strip-centres.js'

afterEach(() => { vi.useRealTimers() })

const box = (left: number, width: number): { hidden: boolean, left: number, width: number } => ({ hidden: false, left, width })

/** A window whose chrome page answers a read after `answerMs`, and counts the reads it was asked for. */
function windowAnswering (answerMs: number, ids: string[]): { entry: ShellWindow, reads: () => number } {
  let reads = 0
  const reply = { ids, boxes: ids.map((_, at) => box(at * 100, 100)) }
  const executeJavaScript = vi.fn(() => {
    reads += 1
    return new Promise((resolve) => { setTimeout(() => { resolve(reply) }, answerMs) })
  })
  const entry = {
    window: { isDestroyed: () => false },
    chrome: { webContents: { isDestroyed: () => false, executeJavaScript } },
    tabs: { getState: () => ({ tabs: ids.map((id) => ({ id })) }) }
  } as unknown as ShellWindow
  return { entry, reads: () => reads }
}

describe('parseStripBoxes', () => {
  it('turns boxes into centres, with a hidden tab at the centre of the shown tab before it', () => {
    expect(parseStripBoxes({ ids: ['a', 'g', 'b'], boxes: [box(0, 100), { hidden: true, left: 0, width: 0 }, box(100, 100)] }))
      .toEqual({ ids: ['a', 'g', 'b'], centres: [50, 50, 150] })
  })

  it('refuses boxes that are not numbers', () => {
    expect(parseStripBoxes({ ids: ['a'], boxes: [{ hidden: false, left: 'x', width: 1 }] })).toBeNull()
    expect(parseStripBoxes({ ids: ['a'], boxes: [] })).toBeNull()
    expect(parseStripBoxes(null)).toBeNull()
  })
})

describe('refreshStripLayouts', () => {
  it('waits for a read already running rather than returning with nothing', async () => {
    vi.useFakeTimers()
    const { entry, reads } = windowAnswering(50, ['a', 'b'])
    void refreshStripLayouts([entry], 1000)
    const second = refreshStripLayouts([entry], 1000)
    await vi.advanceTimersByTimeAsync(60)
    await second
    expect(reads()).toBe(1)
    expect(stripCentresFor(entry)).toEqual([50, 150])
  })

  it('gives up after the time allowed, so a page that does not answer never holds a drop back', async () => {
    vi.useFakeTimers()
    const { entry } = windowAnswering(10_000, ['a'])
    let done = false
    void refreshStripLayouts([entry], 150).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(149)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(done).toBe(true)
    expect(stripCentresFor(entry)).toBeNull()
  })
})
