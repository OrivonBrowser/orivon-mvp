import { describe, expect, it, vi } from 'vitest'
import { DISPLAY_CAPTURE_CHANNEL, DISPLAY_CAPTURE_PICK_CHANNEL } from '../../channels.js'
import { readHints, readPick, readReport, registerDisplayIpc } from '../display-ipc.js'

describe('reading what the preload sends', () => {
  const PICK = { type: 'pick', audio: true, hints: { displaySurface: 'browser', preferCurrentTab: true, systemAudio: 'exclude' }, activation: false }

  it('reads a pick with exactly its keys', () => {
    expect(readPick(PICK)).toEqual({ audio: true, hints: { displaySurface: 'browser', preferCurrentTab: true, systemAudio: 'exclude' }, activation: false })
    expect(readPick({ ...PICK, hints: {} })?.hints).toEqual({})
  })

  it.each([
    ['an extra key', { ...PICK, extra: 1 }],
    ['a missing key', { type: 'pick', audio: true, hints: {} }],
    ['a wrong type', { ...PICK, activation: 'yes' }],
    ['another type', { ...PICK, type: 'arm' }],
    ['an unknown hint', { ...PICK, hints: { displaySurface: 'browser', surprise: true } }],
    ['a hint outside its set', { ...PICK, hints: { displaySurface: 'everything' } }],
    ['a hint of the wrong type', { ...PICK, hints: { preferCurrentTab: 'yes' } }],
    ['hints that are not an object', { ...PICK, hints: [] }],
    ['null', null],
    ['a string', 'pick']
  ])('refuses a pick with %s', (_name, raw) => {
    expect(readPick(raw)).toBeUndefined()
  })

  it('reads the five reports and refuses the rest', () => {
    expect(readReport({ type: 'arm', nonce: 'abc' })).toEqual({ type: 'arm', nonce: 'abc' })
    expect(readReport({ type: 'called', nonce: 'abc', rejectedEarly: false })).toEqual({ type: 'called', nonce: 'abc', rejectedEarly: false })
    expect(readReport({ type: 'tracks-ended', nonce: 'abc' })).toEqual({ type: 'tracks-ended', nonce: 'abc' })
    expect(readReport({ type: 'received', nonce: 'abc' })).toEqual({ type: 'received', nonce: 'abc' })
    for (const name of ['NotAllowedError', 'AbortError', 'NotReadableError', 'NotFoundError']) expect(readReport({ type: 'failed', nonce: 'abc', name })).toEqual({ type: 'failed', nonce: 'abc', name })
    for (const bad of [
      { type: 'arm' }, { type: 'arm', nonce: '' }, { type: 'arm', nonce: 'x'.repeat(129) }, { type: 'arm', nonce: 1 },
      { type: 'arm', nonce: 'a', extra: 1 }, { type: 'called', nonce: 'a' }, { type: 'called', nonce: 'a', rejectedEarly: 'no' },
      { type: 'called', nonce: 'a', rejectedEarly: false, extra: 1 }, { type: 'tracks-ended', nonce: 'a', rejectedEarly: false },
      { type: 'received', nonce: 'a', extra: 1 }, { type: 'received' }, { type: 'failed', nonce: 'a' }, { type: 'failed', nonce: 'a', name: 'SecurityError' },
      { type: 'failed', nonce: 'a', name: 7 }, { type: 'failed', nonce: 'a', name: 'AbortError', message: 'x' }, { type: 'failed', nonce: '', name: 'AbortError' },
      { type: 'stop', nonce: 'a' }, null, 'arm', []
    ]) expect(readReport(bad)).toBeUndefined()
  })

  it('reads hints one at a time', () => {
    expect(readHints({ monitorTypeSurfaces: 'include', selfBrowserSurface: 'exclude' })).toEqual({ monitorTypeSurfaces: 'include', selfBrowserSurface: 'exclude' })
    expect(readHints({ displaySurface: 'monitor' })).toEqual({ displaySurface: 'monitor' })
    expect(readHints({ systemAudio: 'maybe' })).toBeUndefined()
  })
})

describe('the display channels', () => {
  function setup (isTab = true): {
    handle: (event: object, raw: unknown) => Promise<unknown>
    on: (event: object, raw: unknown) => void
    gate: { pick: ReturnType<typeof vi.fn>, arm: ReturnType<typeof vi.fn>, called: ReturnType<typeof vi.fn>, tracksEnded: ReturnType<typeof vi.fn>, received: ReturnType<typeof vi.fn>, failed: ReturnType<typeof vi.fn>, endForTab: ReturnType<typeof vi.fn> }
    sender: { isDestroyed: () => boolean, mainFrame: object }
  } {
    const gate = { pick: vi.fn(async () => await Promise.resolve({ type: 'go', nonce: 'n' })), arm: vi.fn(), called: vi.fn(), tracksEnded: vi.fn(), received: vi.fn(), failed: vi.fn(), endForTab: vi.fn() }
    const channels = new Map<string, (event: never, raw: unknown) => unknown>()
    registerDisplayIpc({
      ipc: { handle: (channel, listener) => { channels.set(channel, listener as never) }, on: (channel, listener) => { channels.set(channel, listener as never) } },
      gate: gate as never,
      isTab: () => isTab
    })
    return {
      handle: channels.get(DISPLAY_CAPTURE_PICK_CHANNEL) as never,
      on: channels.get(DISPLAY_CAPTURE_CHANNEL) as never,
      gate,
      sender: { isDestroyed: () => false, mainFrame: {} }
    }
  }
  const PICK = { type: 'pick', audio: false, hints: {}, activation: true }

  it('hands a valid pick from a tab\'s top frame to the gate', async () => {
    const { handle, gate, sender } = setup()
    expect(await handle({ sender, senderFrame: sender.mainFrame }, PICK)).toEqual({ type: 'go', nonce: 'n' })
    expect(gate.pick).toHaveBeenCalledWith(sender, { audio: false, hints: {}, activation: true })
  })

  it('refuses a pick from a subframe, a destroyed tab, a non-tab and a bad payload', async () => {
    const { handle, gate, sender } = setup()
    const refusal = { type: 'refused', reason: 'denied' }
    expect(await handle({ sender, senderFrame: {} }, PICK)).toEqual(refusal)
    expect(await handle({ sender, senderFrame: null }, PICK)).toEqual(refusal)
    expect(await handle({ sender: { ...sender, isDestroyed: () => true }, senderFrame: sender.mainFrame }, PICK)).toEqual(refusal)
    expect(await handle({ sender, senderFrame: sender.mainFrame }, { ...PICK, extra: 1 })).toEqual(refusal)
    expect(await setup(false).handle({ sender, senderFrame: sender.mainFrame }, PICK)).toEqual(refusal)
    expect(gate.pick).not.toHaveBeenCalled()
  })

  it('routes the five reports from a tab\'s top frame, and drops them from anywhere else', () => {
    const { on, gate, sender } = setup()
    const from = { sender, senderFrame: sender.mainFrame }
    on(from, { type: 'arm', nonce: 'n' })
    on(from, { type: 'called', nonce: 'n', rejectedEarly: true })
    on(from, { type: 'tracks-ended', nonce: 'n' })
    on(from, { type: 'received', nonce: 'n' })
    on(from, { type: 'failed', nonce: 'n', name: 'NotAllowedError' })
    expect(gate.received).toHaveBeenCalledWith(sender, 'n')
    expect(gate.failed).toHaveBeenCalledWith(sender, 'n', 'NotAllowedError')
    expect(gate.arm).toHaveBeenCalledWith(sender, 'n')
    expect(gate.called).toHaveBeenCalledWith(sender, 'n', true)
    expect(gate.tracksEnded).toHaveBeenCalledWith(sender, 'n')
    on({ sender, senderFrame: {} }, { type: 'arm', nonce: 'n' })
    on(from, { type: 'arm' })
    expect(gate.arm).toHaveBeenCalledOnce()
    setup(false).on(from, { type: 'arm', nonce: 'n' })
  })
})
