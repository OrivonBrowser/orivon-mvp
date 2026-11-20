import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  globalThis.__orivonDevStartup = undefined
  delete process.env['ORIVON_TEST_WEB_READY_DELAY_MS']
})

async function load (testBuild = false) {
  if (testBuild) vi.stubGlobal('__ORIVON_DEV_GRANT_ENABLED__', true)
  vi.resetModules()
  return await import('../web-ready.js')
}

describe('web content gate: shut', () => {
  it('is not ready before the start opens it', async () => {
    const { isWebContentReady } = await load()
    expect(isWebContentReady()).toBe(false)
  })

  it('holds what asks to wait, answers true for it, and runs it in the order it asked once opened', async () => {
    const { deferUntilWebReady, openWebContent } = await load()
    const ran: string[] = []
    expect(deferUntilWebReady(() => { ran.push('first') })).toBe(true)
    expect(deferUntilWebReady(() => { ran.push('second') })).toBe(true)
    expect(ran).toEqual([])

    openWebContent()
    await vi.waitFor(() => { expect(ran).toEqual(['first', 'second']) })
  })

  it('does not run what waited until the gate opens, even after the event loop turns', async () => {
    const { deferUntilWebReady } = await load()
    const later = vi.fn()
    deferUntilWebReady(later)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(later).not.toHaveBeenCalled()
  })

  it('keeps going when one request that waited throws', async () => {
    const { deferUntilWebReady, openWebContent } = await load()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = vi.fn()
    deferUntilWebReady(() => { throw new Error('boom') })
    deferUntilWebReady(second)
    openWebContent()
    await vi.waitFor(() => { expect(second).toHaveBeenCalledOnce() })
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})

describe('web content gate: open', () => {
  it('is ready at once, answers false for a request and runs nothing itself', async () => {
    const { deferUntilWebReady, isWebContentReady, openWebContent } = await load()
    openWebContent()
    const later = vi.fn()
    expect(isWebContentReady()).toBe(true)
    expect(deferUntilWebReady(later)).toBe(false)
    await Promise.resolve()
    expect(later).not.toHaveBeenCalled()
  })

  it('settles webContentReady, for a caller that awaits it, at the opening', async () => {
    const { openWebContent, webContentReady } = await load()
    const settled = vi.fn()
    void webContentReady().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    openWebContent()
    await vi.waitFor(() => { expect(settled).toHaveBeenCalledOnce() })
  })

  it('opens once: a second call neither reopens nor runs a request again', async () => {
    const { deferUntilWebReady, openWebContent } = await load()
    const later = vi.fn()
    deferUntilWebReady(later)
    openWebContent()
    openWebContent()
    await vi.waitFor(() => { expect(later).toHaveBeenCalledOnce() })
    await Promise.resolve()
    expect(later).toHaveBeenCalledOnce()
  })

  it('answers false to a request made by one that waited, so that it goes on at once', async () => {
    const { deferUntilWebReady, openWebContent } = await load()
    const ran: string[] = []
    deferUntilWebReady(() => {
      ran.push('waited')
      expect(deferUntilWebReady(() => { ran.push('late') })).toBe(false)
      ran.push('after-check')
    })
    openWebContent()
    await vi.waitFor(() => { expect(ran).toEqual(['waited', 'after-check']) })
  })
})

describe('the test seam', () => {
  it('holds the gate shut for the delay a test build asks for, then opens it', async () => {
    vi.useFakeTimers()
    process.env['ORIVON_TEST_WEB_READY_DELAY_MS'] = '5000'
    const { deferUntilWebReady, isWebContentReady, openWebContent } = await load(true)
    const later = vi.fn()
    deferUntilWebReady(later)
    openWebContent()
    vi.advanceTimersByTime(4999)
    expect(isWebContentReady()).toBe(false)
    expect(later).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(isWebContentReady()).toBe(true)
    await vi.waitFor(() => { expect(later).toHaveBeenCalledOnce() })
  })

  it('publishes the promise a test awaits, which settles when the gate opens', async () => {
    const { openWebContent } = await load(true)
    const published = globalThis.__orivonDevStartup?.webReady
    expect(published).toBeInstanceOf(Promise)
    const settled = vi.fn()
    void published?.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    openWebContent()
    await vi.waitFor(() => { expect(settled).toHaveBeenCalledOnce() })
  })

  it('publishes nothing and ignores the delay in an ordinary build', async () => {
    process.env['ORIVON_TEST_WEB_READY_DELAY_MS'] = '5000'
    const { isWebContentReady, openWebContent } = await load(false)
    expect(globalThis.__orivonDevStartup).toBeUndefined()
    openWebContent()
    expect(isWebContentReady()).toBe(true)
  })
})
