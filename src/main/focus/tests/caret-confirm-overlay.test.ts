import { describe, expect, it, vi } from 'vitest'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'

const slotClosed = vi.fn()
vi.mock('../../overlays/tab-slots.js', () => ({ requestSlot: vi.fn(), slotClosed: (...args: unknown[]) => { slotClosed(...args) } }))
const showToast = vi.fn()
vi.mock('../../page-tools/toast.js', () => ({ showToast: (...args: unknown[]) => { showToast(...args) } }))

const { caretConfirmOverlay } = await import('../caret-confirm-overlay.js')

function attach (keys: string[] | null = ['F7']): { handler: OverlayHandler, close: ReturnType<typeof vi.fn>, set: ReturnType<typeof vi.fn>, win: OverlayWindow } {
  const close = vi.fn()
  const set = vi.fn()
  const win = {
    window: { tabs: {} },
    services: { settings: { set, get: () => true }, shortcuts: { rows: () => [{ id: 'caret.toggle', keys }] } },
    send: vi.fn(),
    close
  } as unknown as OverlayWindow
  return { handler: caretConfirmOverlay.attach(win), close, set, win }
}

describe('the caret confirmation sheet', () => {
  it('is a 420px sheet in the middle of the tab that only a tab switch dismisses', () => {
    expect(caretConfirmOverlay).toMatchObject({
      name: 'caret-confirm',
      placement: { kind: 'area', at: 'center', width: 420 },
      focus: 'take',
      layer: 'bar',
      closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
      keep: 'fresh'
    })
  })

  it('tells the page the key that turns it off', () => {
    expect(attach(['F7']).handler.show?.(null)).toEqual({ keys: ['F7'] })
    expect(attach(null).handler.show?.(null)).toEqual({ keys: null })
  })

  it('turns it on and closes when confirmed, and keeps asking unless told not to', () => {
    const { handler, close, set } = attach()
    handler.request({ type: 'confirm', dontAsk: false })
    expect(close).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith('accessibility.caretBrowsing', true)
    expect(set).not.toHaveBeenCalledWith('accessibility.caretAsk', false)
    expect(showToast).toHaveBeenCalledWith(expect.anything(), 'caretOn')
  })

  it('stops asking when the box was ticked', () => {
    const { handler, set } = attach()
    handler.request({ type: 'confirm', dontAsk: true })
    expect(set).toHaveBeenCalledWith('accessibility.caretAsk', false)
    expect(set).toHaveBeenCalledWith('accessibility.caretBrowsing', true)
  })

  it('closes and changes nothing on cancel', () => {
    const { handler, close, set } = attach()
    handler.request({ type: 'cancel' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(set).not.toHaveBeenCalled()
  })

  it.each([undefined, null, 'confirm', 7, {}, { type: 'confirm' }, { type: 'confirm', dontAsk: 'yes' }, { type: 'turn-on', dontAsk: true }, { type: 'toggle' }])('refuses %j', (command) => {
    const { handler, close, set } = attach()
    handler.request(command)
    expect(close).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('tells the tab slots when it closes', () => {
    const { handler, win } = attach()
    handler.closed?.('escape')
    expect(slotClosed).toHaveBeenCalledWith(win.window, 'caret-confirm', 'escape')
  })
})
