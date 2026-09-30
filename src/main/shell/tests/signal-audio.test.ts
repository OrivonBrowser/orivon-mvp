import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { applyMuted, audioSignal, mutedFor } from '../signals/audio.js'
import { applyTabSignals, signalState, wireTabSignals } from '../tab-signals.js'

function page (audible = false): EventEmitter & { setAudioMuted: ReturnType<typeof vi.fn>, isCurrentlyAudible: ReturnType<typeof vi.fn>, isDestroyed: () => boolean } {
  const emitter = new EventEmitter() as never as ReturnType<typeof page>
  emitter.setAudioMuted = vi.fn()
  emitter.isCurrentlyAudible = vi.fn(() => audible)
  emitter.isDestroyed = () => false
  return emitter
}

function tabOf (wc: ReturnType<typeof page>, muted?: boolean): { record: never, emitState: ReturnType<typeof vi.fn> } {
  const emitState = vi.fn()
  const record = { muted, host: { emitState }, view: { webContents: wc } } as never
  return { record, emitState }
}

describe('the audio signal', () => {
  it('mutes a page for as long as the record says', () => {
    expect(mutedFor({ muted: true } as never, {} as never)).toBe(true)
    expect(mutedFor({ muted: false } as never, {} as never)).toBe(false)
    expect(mutedFor({} as never, {} as never)).toBe(false)
  })

  it('applies the record\'s mute when a view is wired and whenever a view returns', () => {
    const wc = page()
    const { record } = tabOf(wc, true)
    wireTabSignals('t', record, [audioSignal])
    expect(wc.setAudioMuted).toHaveBeenLastCalledWith(true)

    const returned = page()
    const again = { ...(record as object), view: { webContents: returned } } as never
    applyTabSignals('t', again, [audioSignal])
    expect(returned.setAudioMuted).toHaveBeenCalledWith(true)
  })

  it('does not touch a page that has gone', () => {
    const wc = page()
    wc.isDestroyed = () => true
    applyMuted(tabOf(wc, true).record)
    expect(wc.setAudioMuted).not.toHaveBeenCalled()
  })

  it('pushes the state when the page starts or stops making sound', () => {
    const wc = page()
    const { record, emitState } = tabOf(wc)
    wireTabSignals('t', record, [audioSignal])

    wc.emit('audio-state-changed', { audible: true })

    expect(emitState).toHaveBeenCalledTimes(1)
  })

  it('ignores the event of a view that is no longer the tab\'s', () => {
    const wc = page()
    const tab = tabOf(wc)
    wireTabSignals('t', tab.record, [audioSignal]);
    (tab.record as { view: unknown }).view = { webContents: page() }

    wc.emit('audio-state-changed', { audible: true })

    expect(tab.emitState).not.toHaveBeenCalled()
  })

  it('reads both flags into the state, and stays unmuted and silent for a page that is gone', () => {
    expect(signalState({ muted: true } as never, page(true) as never, [audioSignal])).toEqual({ muted: true, audible: true })
    expect(signalState({} as never, page(false) as never, [audioSignal])).toEqual({ muted: false, audible: false })
    expect(signalState({ muted: true } as never, undefined, [audioSignal])).toEqual({ muted: true, audible: false })
  })

  it('still calls a muted page audible: the badge shows the mute, not the sound', () => {
    expect(signalState({ muted: true } as never, page(true) as never, [audioSignal])).toMatchObject({ muted: true, audible: true })
  })
})
