import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayHandler } from '../../overlays/overlay-types.js'
import { MAX_WAITING, tabSlotEvents } from '../../overlays/tab-slots.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import {
  ALLOW_GUARD_MS, askPermission, createPermissionPrompt, PERMISSION_OVERLAY, permissionOverlay,
  type PermissionAsk, type PermissionPromptView
} from '../permission-prompt-overlay.js'

interface Fake {
  window: ShellWindow
  handler: OverlayHandler
  views: Array<PermissionPromptView | undefined>
  closes: number
}

/** A window whose overlay host shows through the real handler, as the host does. */
function fakeWindow (): Fake {
  const fake = { views: [] as Fake['views'], closes: 0 } as Fake
  let handler: OverlayHandler | undefined
  const window = {
    tabs: { getState: () => ({ activeTabId: 'a' }) },
    overlays: {
      show: (_name: string, _anchor: unknown, payload: unknown) => { fake.views.push(handler?.show?.(payload) as PermissionPromptView | undefined) },
      close: () => {}
    }
  } as unknown as ShellWindow
  handler = createPermissionPrompt({ window, close: () => { fake.closes++; handler?.closed?.('request') }, send: () => {} } as never)
  fake.window = window
  fake.handler = handler
  return fake
}

const ask = (id = 'e'.repeat(32)): PermissionAsk => ({ extensionId: id, name: 'Tidy Tabs', icon: undefined, lines: [{ words: 'Read and change your browsing history' }] })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the prompt overlay definition', () => {
  it('is a centred sheet that takes focus and closes on blur and tab switch', () => {
    expect(permissionOverlay.name).toBe(PERMISSION_OVERLAY)
    expect(permissionOverlay.placement).toEqual({ kind: 'area', at: 'center', width: 420 })
    expect(permissionOverlay.focus).toBe('take')
    expect(permissionOverlay.closeOn).toEqual({ blur: true, tabSwitch: true, navigation: false, layout: false })
    expect(permissionOverlay.keep).toBe('fresh')
  })
})

describe('askPermission', () => {
  it('shows the extension\'s name, id and lines, with the guard length', async () => {
    const fake = fakeWindow()
    void askPermission(fake.window, 'a', ask())
    expect(fake.views).toEqual([{ name: 'Tidy Tabs', id: 'e'.repeat(32), icon: undefined, lines: [{ words: 'Read and change your browsing history' }], guardMs: ALLOW_GUARD_MS }])
  })

  it('ignores Allow until the guard has passed, then resolves true', async () => {
    const fake = fakeWindow()
    const answer = askPermission(fake.window, 'a', ask())
    fake.handler.request({ allow: true })
    expect(fake.closes).toBe(0)
    vi.advanceTimersByTime(ALLOW_GUARD_MS + 100)
    fake.handler.request({ allow: true })
    expect(await answer).toBe(true)
    expect(fake.closes).toBe(1)
  })

  it('takes Deny at once', async () => {
    const fake = fakeWindow()
    const answer = askPermission(fake.window, 'a', ask())
    fake.handler.request({ allow: false })
    expect(await answer).toBe(false)
  })

  it.each(['escape', 'blur', 'replaced', 'window-closed'] as const)('a close by %s is a refusal', async (reason) => {
    const fake = fakeWindow()
    const answer = askPermission(fake.window, 'a', ask())
    fake.handler.closed?.(reason)
    expect(await answer).toBe(false)
  })

  it('refuses a command that is not exactly { allow: boolean }', async () => {
    const fake = fakeWindow()
    const answer = askPermission(fake.window, 'a', ask())
    vi.advanceTimersByTime(ALLOW_GUARD_MS + 100)
    for (const bad of [undefined, null, 'allow', { allow: 'yes' }, { allow: true, extra: 1 }, {}]) fake.handler.request(bad)
    expect(fake.closes).toBe(0)
    fake.handler.request({ allow: false })
    expect(await answer).toBe(false)
  })

  it('keeps the ask across a tab switch and shows it again with a fresh guard', async () => {
    const fake = fakeWindow()
    const answer = askPermission(fake.window, 'a', ask())
    vi.advanceTimersByTime(ALLOW_GUARD_MS + 100)
    fake.handler.closed?.('tab-switch')
    tabSlotEvents.tabActivated(fake.window, 'a')
    await Promise.resolve()
    expect(fake.views).toHaveLength(2)
    fake.handler.request({ allow: true })
    expect(fake.closes).toBe(0)
    vi.advanceTimersByTime(ALLOW_GUARD_MS + 100)
    fake.handler.request({ allow: true })
    expect(await answer).toBe(true)
  })

  it('queues a second ask behind the first and shows it when the first is answered', async () => {
    const fake = fakeWindow()
    const first = askPermission(fake.window, 'a', ask('a'.repeat(32)))
    const second = askPermission(fake.window, 'a', ask('b'.repeat(32)))
    expect(fake.views).toHaveLength(1)
    fake.handler.request({ allow: false })
    await first
    expect(fake.views.map((view) => view?.id)).toEqual(['a'.repeat(32), 'b'.repeat(32)])
    vi.advanceTimersByTime(ALLOW_GUARD_MS + 100)
    fake.handler.request({ allow: true })
    expect(await second).toBe(true)
  })

  it('answers a full queue with a refusal', async () => {
    const fake = fakeWindow()
    for (let i = 0; i <= MAX_WAITING; i++) void askPermission(fake.window, 'a', ask(String(i).repeat(32)))
    expect(await askPermission(fake.window, 'a', ask('z'.repeat(32)))).toBe(false)
  })

  it('refuses every ask of a window that is disposed', async () => {
    const fake = fakeWindow()
    const answer = askPermission(fake.window, 'a', ask())
    fake.handler.disposed?.()
    expect(await answer).toBe(false)
  })
})
