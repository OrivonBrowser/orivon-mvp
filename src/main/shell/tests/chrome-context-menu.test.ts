import { describe, expect, it, vi } from 'vitest'
import { chromeContextMenuHost } from '../chrome-context-menu.js'

function devtools (allowed: boolean): { allowed: ReturnType<typeof vi.fn>, inspect: ReturnType<typeof vi.fn> } {
  return { allowed: vi.fn(() => allowed), inspect: vi.fn() }
}

describe('chromeContextMenuHost -- Inspect on the chrome\'s own right-click menu', () => {
  it('offers it where DevToolsGate.allowed() says so, wired to DevToolsGate.inspect', () => {
    const dt = devtools(true)
    const contents = {} as never
    const window = {} as never
    const host = chromeContextMenuHost(dt as never, contents, window, vi.fn())

    expect(host.inspect).toBeTypeOf('function')
    host.inspect?.(3, 4)
    expect(dt.inspect).toHaveBeenCalledWith(contents, window, 3, 4)
  })

  it('is absent where DevToolsGate.allowed() refuses -- dev mode off is one such answer, tested against the real gate in shell-services-devtools.test.ts', () => {
    const dt = devtools(false)
    const host = chromeContextMenuHost(dt as never, {} as never, {} as never, vi.fn())

    expect(host.inspect).toBeUndefined()
  })

  it('is absent with no devtools service at all', () => {
    const host = chromeContextMenuHost(undefined, {} as never, {} as never, vi.fn())

    expect(host.inspect).toBeUndefined()
  })

  it('carries the window and openInNewTab straight through', () => {
    const window = {} as never
    const openInNewTab = vi.fn()
    const host = chromeContextMenuHost(undefined, {} as never, window, openInNewTab)

    expect(host.window).toBe(window)
    expect(host.openInNewTab).toBe(openInNewTab)
  })

  it('carries Paste and Go through when the window supplies one, and has none otherwise', () => {
    const go = vi.fn()
    expect(chromeContextMenuHost(undefined, {} as never, {} as never, vi.fn(), go).pasteAndGo).toBe(go)
    expect(chromeContextMenuHost(undefined, {} as never, {} as never, vi.fn()).pasteAndGo).toBeUndefined()
  })

  it('offers no page items: no tab navigation, no page tools', () => {
    const host = chromeContextMenuHost(undefined, {} as never, {} as never, vi.fn())
    expect(host.page).toBeUndefined()
    expect(host.runCommand).toBeUndefined()
  })
})
