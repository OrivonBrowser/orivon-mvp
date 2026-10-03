import { describe, expect, it, vi } from 'vitest'
import { runShellInstallers, SHELL_INSTALLERS, type ShellInstaller } from '../shell-installers.js'

const NONE = {} as never

describe('SHELL_INSTALLERS', () => {
  it('names each installer once', () => {
    const names = SHELL_INSTALLERS.map((installer) => installer.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([
      'auth', 'autofill', 'choosers', 'content-settings', 'focus', 'form-watch', 'load-errors', 'memory-saver',
      'privacy-net', 'questions', 'reader', 'side-panel', 'site-permissions', 'tab-groups', 'tab-slots', 'tab-visibility'
    ])
  })

  it('runs every reserved installer without touching the app, the services or the context', () => {
    const untouched = new Proxy({}, { get: () => { throw new Error('an installer touched its arguments') } })
    expect(() => { runShellInstallers(untouched as never, untouched as never, untouched as never, untouched as never) }).not.toThrow()
  })
})

describe('runShellInstallers', () => {
  it('passes the app, the services, the context and the runtime, in registration order', () => {
    const order: string[] = []
    const make = (name: string): ShellInstaller => ({ name, install: (...args) => { order.push(name); expect(args).toHaveLength(4) } })
    runShellInstallers(NONE, NONE, NONE, NONE, [make('a'), make('b')])
    expect(order).toEqual(['a', 'b'])
  })

  it('logs an installer that throws by name and still runs the ones after it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const later = vi.fn()
      runShellInstallers(NONE, NONE, NONE, NONE, [{ name: 'broken', install: () => { throw new Error('boom') } }, { name: 'fine', install: later }])
      expect(later).toHaveBeenCalledOnce()
      expect(error.mock.calls[0]?.[0]).toContain('broken')
    } finally {
      error.mockRestore()
    }
  })
})
