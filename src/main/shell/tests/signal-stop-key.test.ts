import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { stopKeySignal } from '../signals/stop-key.js'
import type { TabSignalContext } from '../tab-signals.js'

function wired (loading: boolean, shown = true): { press: (input: Record<string, unknown>) => { preventDefault: ReturnType<typeof vi.fn> }, stop: ReturnType<typeof vi.fn> } {
  const wc = Object.assign(new EventEmitter(), { isLoadingMainFrame: () => loading, stop: vi.fn() })
  stopKeySignal.wire?.({ wc, shown: () => shown } as unknown as TabSignalContext)
  return {
    stop: wc.stop,
    press: (input) => {
      const event = { preventDefault: vi.fn() }
      wc.emit('before-input-event', event, { type: 'keyDown', key: 'Escape', shift: false, control: false, alt: false, meta: false, ...input })
      return event
    }
  }
}

describe('the stop key signal', () => {
  it('stops a page that is loading on a bare Escape, and never takes the key from the page', () => {
    const { press, stop } = wired(true)

    const event = press({})

    expect(stop).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('leaves a page that has finished loading alone', () => {
    const { press, stop } = wired(false)

    press({})

    expect(stop).not.toHaveBeenCalled()
  })

  it.each([['Shift', { shift: true }], ['Ctrl', { control: true }], ['Alt', { alt: true }], ['Meta', { meta: true }]])('ignores Escape with %s held', (_name, modifier) => {
    const { press, stop } = wired(true)

    press(modifier)

    expect(stop).not.toHaveBeenCalled()
  })

  it('ignores other keys and the key coming back up', () => {
    const { press, stop } = wired(true)

    press({ key: 'Enter' })
    press({ type: 'keyUp' })

    expect(stop).not.toHaveBeenCalled()
  })

  it('ignores a view that is swapped out of its tab', () => {
    const { press, stop } = wired(true, false)

    press({})

    expect(stop).not.toHaveBeenCalled()
  })
})
