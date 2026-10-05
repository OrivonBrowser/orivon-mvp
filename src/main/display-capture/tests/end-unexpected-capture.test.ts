import { describe, expect, it, vi } from 'vitest'
import { endUnexpectedCapture } from '../end-unexpected-capture.js'

describe('endUnexpectedCapture', () => {
  it('reloads the tab and logs it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const reload = vi.fn()
      endUnexpectedCapture({ reload, isDestroyed: () => false, getURL: () => 'https://a.example/' })
      expect(reload).toHaveBeenCalledOnce()
      expect(error).toHaveBeenCalledOnce()
    } finally {
      error.mockRestore()
    }
  })

  it('leaves a destroyed tab alone', () => {
    const reload = vi.fn()
    endUnexpectedCapture({ reload, isDestroyed: () => true, getURL: () => '' })
    expect(reload).not.toHaveBeenCalled()
  })
})
