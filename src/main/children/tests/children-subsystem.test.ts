import { describe, expect, it, vi } from 'vitest'
import type { SubsystemContext } from '../../registry.js'

// F5: a rejected registry.connect() must never become an uncaught rejection
// (index.ts's own unhandledRejection handler is app.exit(1) -- the whole
// browser, for one failed connect). children-subsystem.ts wires
// ipcMain.on(CHILD_HOST_CONNECT_CHANNEL, ...) directly, so this test mocks
// 'electron' to capture that handler and every module this subsystem builds,
// so it can drive registry.connect() to reject and assert nothing throws.

const { onHandlers, beforeQuitHandlers } = vi.hoisted(() => ({
  onHandlers: new Map<string, (event: unknown) => void>(),
  beforeQuitHandlers: [] as Array<() => void>
}))

vi.mock('electron', () => ({
  app: {
    on: vi.fn((event: string, handler: () => void) => { if (event === 'before-quit') beforeQuitHandlers.push(handler) })
  },
  ipcMain: {
    on: vi.fn((channel: string, handler: (event: unknown) => void) => { onHandlers.set(channel, handler) })
  }
}))

vi.mock('../watch-pages.js', () => ({ watchPages: vi.fn() }))
vi.mock('../page-tracker.js', () => ({ createPageTracker: vi.fn(() => ({})) }))

const connectMock = vi.fn(async () => { throw new Error('host build failed') })
vi.mock('../child-host.js', () => ({ createChildHostPool: vi.fn(() => ({})) }))
vi.mock('../registry.js', () => ({
  createChildHostRegistry: vi.fn(() => ({ connect: connectMock, closeAll: vi.fn(async () => {}) }))
}))

const { childrenSubsystem } = await import('../children-subsystem.js')
const { CHILD_HOST_CONNECT_CHANNEL } = await import('../../channels.js')

describe('childrenSubsystem', () => {
  it('a rejected connect() is caught and logged, never an uncaught rejection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ctx = { broker: {} } as unknown as SubsystemContext
      childrenSubsystem.afterReady?.(ctx)

      const handler = onHandlers.get(CHILD_HOST_CONNECT_CHANNEL)
      expect(handler).toBeDefined()
      handler?.({})

      await vi.waitFor(() => { expect(errorSpy).toHaveBeenCalled() })
      expect(errorSpy.mock.calls[0]?.[0]).toContain('a child-host connect failed')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
