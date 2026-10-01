import { describe, expect, it, vi } from 'vitest'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { loginsStatePart } from '../logins-state.js'
import { passwordsKey } from '../passwords-key-action.js'
import { memoryVault } from '../vault.js'

function rig (active: string | null = 't1') {
  const vault = memoryVault()
  const toggle = vi.fn()
  const send = vi.fn()
  const show = vi.fn()
  const window = {
    tabs: { getState: () => ({ activeTabId: active }), partitionOf: () => undefined, liveWebContents: () => undefined },
    overlays: { toggle, send, show, close: vi.fn() }
  } as unknown as ShellWindow
  const settingListeners = new Set<(change: { key: string }) => void>()
  const services = {
    passwords: vault, isPrivate: false,
    settings: { get: () => true, onChange: (listener: (change: { key: string }) => void) => { settingListeners.add(listener); return () => { settingListeners.delete(listener) } } }
  } as unknown as ShellServices
  return { window, services, toggle, send, show, vault, settingListeners }
}

describe('the password button action', () => {
  it('opens the chooser under the button when no offer is waiting', () => {
    const r = rig()
    passwordsKey({ anchor: { x: 1, y: 2, width: 3, height: 4 } }, { window: r.window, services: r.services })
    expect(r.toggle).toHaveBeenCalledWith('password-fill', { x: 1, y: 2, width: 3, height: 4 })
  })

  it('opens it with no place when the anchor is not a rectangle', () => {
    const r = rig()
    for (const payload of [undefined, null, {}, { anchor: 'x' }, { anchor: { x: 'a' } }]) passwordsKey(payload, { window: r.window, services: r.services })
    expect(r.toggle.mock.calls.every((call) => call[1] === undefined)).toBe(true)
    expect(r.toggle).toHaveBeenCalledTimes(5)
  })

  it('does nothing with no tab in front', () => {
    const r = rig(null)
    passwordsKey({}, { window: r.window, services: r.services })
    expect(r.toggle).not.toHaveBeenCalled()
  })
})

describe('the logins state part', () => {
  it('reads the active tab\'s login state, and nothing for no tab', () => {
    const r = rig()
    const ctx = { window: r.window, services: r.services }
    expect(loginsStatePart.read(ctx, { tabs: [], activeTabId: 't1' })).toEqual({ logins: { count: 0, offer: false, signUp: false } })
    expect(loginsStatePart.read(ctx, { tabs: [], activeTabId: null })).toEqual({ logins: { count: 0, offer: false, signUp: false } })
  })

  it('pushes when the vault or a passwords setting changes, and stops on request', async () => {
    const r = rig()
    const push = vi.fn()
    const stop = loginsStatePart.watch?.({ window: r.window, services: r.services }, push)
    await r.vault.save({ origin: 'https://site.example', username: 'a', password: 'b' })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(push).toHaveBeenCalledTimes(1)
    for (const listener of r.settingListeners) { listener({ key: 'passwords.autofill' }); listener({ key: 'appearance.theme' }) }
    expect(push).toHaveBeenCalledTimes(2)
    stop?.()
    await r.vault.save({ origin: 'https://site.example', username: 'c', password: 'd' })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(push).toHaveBeenCalledTimes(2)
    expect(r.settingListeners.size).toBe(0)
  })
})
