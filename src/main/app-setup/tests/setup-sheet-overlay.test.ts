import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import { awaitSheetAnswer, setupSheetOverlay } from '../setup-sheet-overlay.js'
import { sheetView } from '../setup-text.js'

const slotClosed = vi.hoisted(() => vi.fn())
vi.mock('../../overlays/tab-slots.js', () => ({ slotClosed }))

function rig (): { handler: ReturnType<typeof setupSheetOverlay.attach>, window: unknown } {
  const window = {}
  return { handler: setupSheetOverlay.attach({ window, close: vi.fn() } as unknown as OverlayWindow), window }
}

const BLOCKED = sheetView({ kind: 'blocked', name: 'L', differing: ['/a.js'], differingCount: 1, rootMatches: true }, 'ipfs://x/', 'tok-b')
const FAILED = sheetView({ kind: 'download-failed', name: 'L', reason: 'r' }, 'ipfs://x/', 'tok-f')

describe('the app-setup sheet overlay', () => {
  it('is a centred sheet that takes focus and only a tab switch closes', () => {
    expect(setupSheetOverlay).toMatchObject({ name: 'app-setup-sheet', placement: { kind: 'area', at: 'center' }, focus: 'take', layer: 'bar', keep: 'fresh', closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false } })
  })

  it('shows the view main built, and nothing for a payload that is not one', () => {
    const { handler } = rig()
    expect(handler.show?.(BLOCKED)).toEqual(BLOCKED)
    for (const payload of [undefined, null, 'x', {}, { ...BLOCKED, kind: 'other' }, { ...BLOCKED, files: [1] }, { ...BLOCKED, canRetry: 'yes' }]) {
      expect(handler.show?.(payload), JSON.stringify(payload)).toBeUndefined()
    }
  })

  it('answers the question the sheet was shown for, with exactly a token and one fixed word', () => {
    const { handler } = rig()
    const got = vi.fn()
    awaitSheetAnswer('tok-f', got)
    handler.show?.(FAILED)
    handler.request({ type: 'retry', token: 'tok-f' })
    expect(got).toHaveBeenCalledWith('retry')
  })

  it('ignores a command with another token, an unknown word, extra fields, or Try again on a sheet that offers none', () => {
    const { handler } = rig()
    const got = vi.fn()
    awaitSheetAnswer('tok-b', got)
    handler.show?.(BLOCKED)
    for (const command of [undefined, 'retry', { type: 'retry' }, { type: 'retry', token: 'tok-b' }, { type: 'leave', token: 'other' }, { type: 'leave', token: 'tok-b', extra: 1 }, { type: 'run', token: 'tok-b' }]) {
      expect(handler.request(command), JSON.stringify(command)).toBeUndefined()
    }
    expect(got).not.toHaveBeenCalled()
    handler.request({ type: 'leave', token: 'tok-b' })
    expect(got).toHaveBeenCalledWith('leave')
  })

  it('takes no command before it is shown, and tells the slot when it closes', () => {
    const { handler, window } = rig()
    const got = vi.fn()
    awaitSheetAnswer('tok-f', got)
    handler.request({ type: 'leave', token: 'tok-f' })
    expect(got).not.toHaveBeenCalled()
    handler.closed?.('tab-switch')
    expect(slotClosed).toHaveBeenCalledWith(window, 'app-setup-sheet', 'tab-switch')
  })
})
