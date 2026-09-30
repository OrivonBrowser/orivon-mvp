import { describe, expect, it, vi } from 'vitest'
import { CHROME_ACTIONS, runChromeAction } from '../chrome-actions.js'
import type { WindowContext } from '../window-context.js'

function context (): { ctx: WindowContext, record: { muted: boolean, view: { webContents: { isDestroyed: () => boolean, setAudioMuted: ReturnType<typeof vi.fn> } } }, changed: ReturnType<typeof vi.fn> } {
  const record = { muted: false, view: { webContents: { isDestroyed: () => false, setAudioMuted: vi.fn() } } }
  const changed = vi.fn()
  const tabs = { ids: () => ['t1'], record: (id: string) => id === 't1' ? record : undefined, changed }
  return { ctx: { window: { tabs } as never, services: {} as never }, record, changed }
}

describe('the tab.mute chrome action', () => {
  it('is registered under its name', () => {
    expect(CHROME_ACTIONS['tab.mute']).toBeTypeOf('function')
  })

  it('mutes and unmutes the named tab', () => {
    const { ctx, record, changed } = context()
    runChromeAction('tab.mute', { id: 't1' }, ctx)
    expect(record.muted).toBe(true)
    expect(record.view.webContents.setAudioMuted).toHaveBeenLastCalledWith(true)
    runChromeAction('tab.mute', { id: 't1' }, ctx)
    expect(record.muted).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, null, 'x', 7, {}, { id: 7 }, { id: '' }, { id: 't2' }, { id: ['t1'] }, { id: { toString: () => 't1' } }])('ignores the payload %j', (payload) => {
    const { ctx, record, changed } = context()
    runChromeAction('tab.mute', payload, ctx)
    expect(record.muted).toBe(false)
    expect(changed).not.toHaveBeenCalled()
  })
})
