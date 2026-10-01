import { describe, expect, it, vi } from 'vitest'
import { holdsUnsavedInput, UNSAVED_SCRIPT, UNSAVED_WORLD_ID } from '../unsaved-input.js'

const pageAnswering = (run: () => Promise<unknown>): never => ({ executeJavaScriptInIsolatedWorld: vi.fn(run) }) as never

describe('holdsUnsavedInput', () => {
  it('is false only when the page answers false, in the world of its own', async () => {
    const wc = pageAnswering(async () => false)
    expect(await holdsUnsavedInput(wc)).toBe(false)
    expect((wc as unknown as { executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn> }).executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(UNSAVED_WORLD_ID, [{ code: UNSAVED_SCRIPT }])
  })

  it('is true when the page holds input, whatever else it answers, and when it throws', async () => {
    expect(await holdsUnsavedInput(pageAnswering(async () => true))).toBe(true)
    expect(await holdsUnsavedInput(pageAnswering(async () => 'false'))).toBe(true)
    expect(await holdsUnsavedInput(pageAnswering(async () => undefined))).toBe(true)
    expect(await holdsUnsavedInput(pageAnswering(async () => { throw new Error('gone') }))).toBe(true)
  })

  it('counts a page that does not answer in time as holding input', async () => {
    vi.useFakeTimers()
    try {
      const pending = holdsUnsavedInput(pageAnswering(async () => await new Promise(() => {})), 1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await pending).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the page script', () => {
  it('reads one boolean and never the text of a field', () => {
    expect(UNSAVED_SCRIPT).not.toMatch(/return\s+el\.value/)
    expect(UNSAVED_SCRIPT).toContain('defaultValue')
    expect(UNSAVED_SCRIPT).toContain('isContentEditable')
  })
})
