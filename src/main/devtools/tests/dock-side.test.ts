import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { moveToRight, openingMode } from '../dock-side.js'

interface FakeTools { loading: boolean, run: ReturnType<typeof vi.fn> }

function contents (tools: FakeTools | null, destroyed = false): WebContents {
  return {
    isDestroyed: () => destroyed,
    get devToolsWebContents () {
      return tools === null ? null : { isLoading: () => tools.loading, isDestroyed: () => false, executeJavaScript: tools.run }
    }
  } as unknown as WebContents
}

/** The frontend as the page sees it: Electron puts it on `side`, and a move takes it to the right. */
function frontend (start: string | null): { tools: FakeTools, side: () => string | null, set: (side: string) => void } {
  let side = start
  const tools: FakeTools = {
    loading: false,
    run: vi.fn(async () => {
      const was = side
      if (was === 'left') side = 'right'
      return was
    })
  }
  return { tools, side: () => side, set: (next) => { side = next } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('openingMode', () => {
  it('opens beside the page on the left, and every other setting as it is', () => {
    expect(openingMode('right')).toBe('left')
    expect(openingMode('bottom')).toBe('bottom')
    expect(openingMode('undocked')).toBe('undocked')
  })
})

describe('moveToRight', () => {
  it('moves tools Electron put on the left to the right, then stops once they stay there', async () => {
    const page = frontend('left')
    moveToRight(contents(page.tools))
    await vi.advanceTimersByTimeAsync(2000)
    expect(page.side()).toBe('right')
    const calls = page.tools.run.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(page.tools.run.mock.calls.length).toBe(calls)
  })

  it('waits for Electron to apply the left side before it counts the right one as settled', async () => {
    // The frontend starts on the side it remembers; Electron's own start-up puts it on the left afterwards.
    const page = frontend('right')
    moveToRight(contents(page.tools))
    await vi.advanceTimersByTimeAsync(800)
    page.set('left')
    await vi.advanceTimersByTimeAsync(2000)
    expect(page.side()).toBe('right')
  })

  it('waits while the tools are loading, and gives up on a page that has gone', async () => {
    const page = frontend('left')
    page.tools.loading = true
    moveToRight(contents(page.tools))
    await vi.advanceTimersByTimeAsync(500)
    expect(page.tools.run).not.toHaveBeenCalled()
    page.tools.loading = false
    await vi.advanceTimersByTimeAsync(200)
    expect(page.side()).toBe('right')

    const gone = frontend('left')
    moveToRight(contents(gone.tools, true))
    await vi.advanceTimersByTimeAsync(2000)
    expect(gone.tools.run).not.toHaveBeenCalled()
  })

  it('leaves tools that never report a side where they are, and stops asking', async () => {
    const tools: FakeTools = { loading: false, run: vi.fn(async () => null) }
    moveToRight(contents(tools))
    await vi.advanceTimersByTimeAsync(10_000)
    const calls = tools.run.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(tools.run.mock.calls.length).toBe(calls)
  })
})
