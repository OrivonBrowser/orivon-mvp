import { describe, expect, it, vi } from 'vitest'
import { chromeContextMenuHost } from '../chrome-context-menu.js'

function devtools (allowed: boolean): { allowed: ReturnType<typeof vi.fn>, inspect: ReturnType<typeof vi.fn> } {
  return { allowed: vi.fn(() => allowed), inspect: vi.fn() }
}

describe('chromeContextMenuHost -- Inspect on the chrome\'s own right-click menu', () => {
  it('offers it in developer mode, with developer tools allowed on the chrome view', () => {
    const dt = devtools(true)
    const contents = {} as never
    const window = {} as never
    const host = chromeContextMenuHost(() => true, dt as never, contents, window, vi.fn())

    expect(host.inspect).toBeTypeOf('function')
    host.inspect?.(3, 4)
    expect(dt.inspect).toHaveBeenCalledWith(contents, window, 3, 4)
  })

  it('is absent outside developer mode, whatever the developer.tools setting says', () => {
    const dt = devtools(true)
    const host = chromeContextMenuHost(() => false, dt as never, {} as never, {} as never, vi.fn())

    expect(host.inspect).toBeUndefined()
  })

  it('is absent in developer mode when developer tools are not allowed on the chrome view', () => {
    const dt = devtools(false)
    const host = chromeContextMenuHost(() => true, dt as never, {} as never, {} as never, vi.fn())

    expect(host.inspect).toBeUndefined()
  })

  it('is absent with no devtools service at all', () => {
    const host = chromeContextMenuHost(() => true, undefined, {} as never, {} as never, vi.fn())

    expect(host.inspect).toBeUndefined()
  })

  it('carries the window and openInNewTab straight through', () => {
    const window = {} as never
    const openInNewTab = vi.fn()
    const host = chromeContextMenuHost(() => false, undefined, {} as never, window, openInNewTab)

    expect(host.window).toBe(window)
    expect(host.openInNewTab).toBe(openInNewTab)
  })
})
