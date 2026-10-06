import { describe, expect, it, vi } from 'vitest'
import { endUnexpectedCapture } from '../end-unexpected-capture.js'

describe('endUnexpectedCapture', () => {
  it('ends the tab\'s renderer, never reloads it, and logs the reason', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const forcefullyCrashRenderer = vi.fn()
      const reload = vi.fn()
      endUnexpectedCapture({ forcefullyCrashRenderer, reload, isDestroyed: () => false, getURL: () => 'https://a.example/' } as never, 'a request with no ticket followed one that was served')
      expect(forcefullyCrashRenderer).toHaveBeenCalledOnce()
      expect(reload).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledOnce()
      expect(String(error.mock.calls[0]?.[0])).toContain('a request with no ticket followed one that was served')
    } finally {
      error.mockRestore()
    }
  })

  it('leaves a destroyed tab alone', () => {
    const forcefullyCrashRenderer = vi.fn()
    endUnexpectedCapture({ forcefullyCrashRenderer, isDestroyed: () => true, getURL: () => '' }, 'why')
    expect(forcefullyCrashRenderer).not.toHaveBeenCalled()
  })
})
