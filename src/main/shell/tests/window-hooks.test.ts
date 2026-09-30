import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWindowHooks, WINDOW_HOOKS, type WindowHook } from '../window-hooks.js'
import type { WindowContext } from '../window-context.js'

const ctx = { window: {}, services: {} } as unknown as WindowContext
const options = { maximized: true }

afterEach(() => { vi.restoreAllMocks() })

describe('runWindowHooks', () => {
  it('registers each hook once, by name', () => {
    expect(WINDOW_HOOKS.map((hook) => hook.name)).toEqual(['window-state'])
    expect(() => { runWindowHooks('opened', ctx, options, []) }).not.toThrow()
  })

  it('hands the opened phase the window and its options, and the closing phase the window', () => {
    const opened = vi.fn()
    const closing = vi.fn()
    const hooks: WindowHook[] = [{ name: 'both', opened, closing }, { name: 'only-closing', closing }]
    runWindowHooks('opened', ctx, options, hooks)
    expect(opened).toHaveBeenCalledExactlyOnceWith(ctx, options)
    expect(closing).not.toHaveBeenCalled()
    runWindowHooks('closing', ctx, options, hooks)
    expect(closing).toHaveBeenCalledTimes(2)
    expect(closing).toHaveBeenCalledWith(ctx)
  })

  it('logs a hook that throws by name and still runs the ones after it', () => {
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    const later = vi.fn()
    runWindowHooks('opened', ctx, options, [{ name: 'broken', opened: () => { throw new Error('boom') } }, { name: 'later', opened: later }])
    expect(later).toHaveBeenCalledTimes(1)
    expect(complaint).toHaveBeenCalledTimes(1)
    expect(String(complaint.mock.calls[0]?.[0])).toContain('broken')
  })
})
