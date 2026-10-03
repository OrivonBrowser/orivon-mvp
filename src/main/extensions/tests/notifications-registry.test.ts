import { describe, expect, it, vi } from 'vitest'

// UPSTREAM.md patch 66: the notifications an extension raises are kept apart by id, and a
// notification that is replaced does not take its replacement's place in the registry.
const made: any[] = []
vi.mock('electron', () => ({
  app: { name: 'Orivon' },
  Notification: class {
    handlers = new Map<string, () => void>()
    close = vi.fn(() => { queueMicrotask(() => { this.handlers.get('close')?.() }) })
    show = vi.fn()
    on = vi.fn()
    once = (name: string, fn: () => void) => { this.handlers.set(name, fn) }
    constructor (public options: unknown) { made.push(this) }
  }
}))

const { NotificationsAPI } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/notifications.js')

const EXT = 'a'.repeat(32)
const OPTS = { type: 'basic', iconUrl: 'data:image/png;base64,AA==', title: 't', message: 'm' }

function setup (): { call: (name: string, ...args: unknown[]) => Promise<any>, sendEvent: ReturnType<typeof vi.fn> } {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const sendEvent = vi.fn()
  const router = { apiHandler: () => (name: string, fn: (...args: any[]) => unknown) => { handlers.set(name, fn) }, sendEvent }
  new NotificationsAPI({ router, session: { extensions: { on: vi.fn() } } } as never)
  const event = { type: 'frame', sender: {}, extension: { id: EXT } }
  return { call: async (name, ...args) => await handlers.get(name)?.(event, ...args), sendEvent }
}

describe('chrome.notifications.create', () => {
  it('gives each notification created without an id its own', async () => {
    made.length = 0
    const { call } = setup()
    const first = await call('notifications.create', OPTS)
    const second = await call('notifications.create', OPTS)
    expect(first).not.toBe(second)
    expect(made).toHaveLength(2)
    expect(made.every((n) => n.close.mock.calls.length === 0)).toBe(true)
    expect((await call('notifications.getAll')).sort()).toEqual([first, second].sort())
  })

  it('can still clear a notification that replaced another of the same id, and reports no close for the replaced one', async () => {
    made.length = 0
    const { call, sendEvent } = setup()
    await call('notifications.create', 'n1', OPTS)
    await call('notifications.create', 'n1', OPTS)
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    expect(sendEvent).not.toHaveBeenCalled()
    expect(await call('notifications.getAll')).toEqual(['n1'])
    await call('notifications.clear', 'n1')
    expect(made[1].close).toHaveBeenCalledTimes(1)
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    expect(sendEvent).toHaveBeenCalledWith(EXT, 'notifications.onClosed', 'n1', true)
    expect(await call('notifications.getAll')).toEqual([])
  })
})
