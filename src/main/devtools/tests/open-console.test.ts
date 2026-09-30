import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { showConsolePanel } from '../open-console.js'

interface FakeTools { loading: boolean, destroyed: boolean, run: ReturnType<typeof vi.fn> }

function contents (source: FakeTools | null | (() => FakeTools | null), options: { open?: boolean, destroyed?: boolean } = {}): WebContents {
  return {
    isDestroyed: () => options.destroyed ?? false,
    isDevToolsOpened: () => options.open ?? true,
    get devToolsWebContents () {
      const tools = typeof source === 'function' ? source() : source
      return tools === null ? null : { isLoading: () => tools.loading, isDestroyed: () => tools.destroyed, executeJavaScript: tools.run }
    }
  } as unknown as WebContents
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('showConsolePanel', () => {
  it('asks the tools\' own page for the Console panel once they have loaded, and stops when it is selected', async () => {
    const tools: FakeTools = { loading: false, destroyed: false, run: vi.fn(async () => true) }
    showConsolePanel(contents(tools))
    await vi.advanceTimersByTimeAsync(0)
    expect(tools.run).toHaveBeenCalledOnce()
    expect(String(tools.run.mock.calls[0]?.[0])).toContain("showPanel('console')")
    await vi.advanceTimersByTimeAsync(5000)
    expect(tools.run).toHaveBeenCalledOnce()
  })

  it('waits while the tools are still loading, then asks', async () => {
    const tools: FakeTools = { loading: true, destroyed: false, run: vi.fn(async () => true) }
    showConsolePanel(contents(tools))
    await vi.advanceTimersByTimeAsync(450)
    expect(tools.run).not.toHaveBeenCalled()
    tools.loading = false
    await vi.advanceTimersByTimeAsync(150)
    expect(tools.run).toHaveBeenCalledOnce()
  })

  it('asks again while the panel is not yet selected, and when the call throws', async () => {
    const answers = [false, 'rejects', true]
    const tools: FakeTools = {
      loading: false,
      destroyed: false,
      run: vi.fn(async () => {
        const next = answers.shift()
        if (next === 'rejects') throw new Error('not defined')
        return next
      })
    }
    showConsolePanel(contents(tools))
    await vi.advanceTimersByTimeAsync(1000)
    expect(tools.run).toHaveBeenCalledTimes(3)
  })

  it('gives up after six seconds if the panel never reports itself selected', async () => {
    const tools: FakeTools = { loading: false, destroyed: false, run: vi.fn(async () => false) }
    showConsolePanel(contents(tools))
    await vi.advanceTimersByTimeAsync(10_000)
    const calls = tools.run.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(tools.run.mock.calls.length).toBe(calls)
    expect(calls).toBe(40)
  })

  it('waits for the tools page to exist, which it does not for a moment after they are asked for', async () => {
    const tools: FakeTools = { loading: false, destroyed: false, run: vi.fn(async () => true) }
    let exists = false
    showConsolePanel(contents(() => exists ? tools : null, { open: false }))
    await vi.advanceTimersByTimeAsync(400)
    expect(tools.run).not.toHaveBeenCalled()
    exists = true
    await vi.advanceTimersByTimeAsync(200)
    expect(tools.run).toHaveBeenCalledOnce()
  })

  it('waits for tools that are not open yet, and does nothing for a page that is gone or has no tools page', async () => {
    const tools: FakeTools = { loading: false, destroyed: false, run: vi.fn(async () => true) }
    showConsolePanel(contents(tools, { destroyed: true }))
    showConsolePanel(contents(null))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(tools.run).not.toHaveBeenCalled()
  })
})
