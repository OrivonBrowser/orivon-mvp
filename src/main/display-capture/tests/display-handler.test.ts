import { describe, expect, it, vi } from 'vitest'
import { createDisplayHandler, streamsFor } from '../display-handler.js'
import { ticketKey } from '../display-tickets.js'
import type { DisplayChoice } from '../types.js'

const FRAME = { processId: 10, routingId: 2 }
const CONTENTS = { id: 1, mainFrame: FRAME, isDestroyed: () => false } as never
const SHOWN_FRAME = { processId: 11, routingId: 3 }
const SHOWN = { id: 2, mainFrame: SHOWN_FRAME, isDestroyed: () => false } as never

const SCREEN: DisplayChoice = { kind: 'screen', source: { id: 'screen:0:0', name: 'Entire screen' }, systemAudio: true, label: 'Entire screen' }
const TAB: DisplayChoice = { kind: 'tab', tab: SHOWN, audio: true, label: 'A tab' }

function run (choice: DisplayChoice | undefined, request: object = {}, overrides: { frame?: unknown, platform?: NodeJS.Platform } = {}): { answers: object[], start: ReturnType<typeof vi.fn>, consume: ReturnType<typeof vi.fn> } {
  const consume = vi.fn((key: string) => key === ticketKey(1, 10, 2) && choice !== undefined ? { choice, nonce: 'nonce-1' } : undefined)
  const start = vi.fn()
  const handler = createDisplayHandler({
    tickets: { consumeDisplay: consume },
    contentsOf: () => CONTENTS,
    shares: { start },
    platform: overrides.platform ?? 'linux'
  })
  const answers: object[] = []
  handler({ frame: 'frame' in overrides ? overrides.frame : FRAME, securityOrigin: 'https://a.example', videoRequested: true, audioRequested: false, userGesture: true, ...request } as never, (streams) => answers.push(streams))
  return { answers, start, consume }
}

describe('the display handler', () => {
  it('answers a screen choice with the source, and starts the share after the answer', () => {
    const { answers, start } = run(SCREEN)
    expect(answers).toEqual([{ video: { id: 'screen:0:0', name: 'Entire screen' } }])
    expect(start).toHaveBeenCalledWith({ requester: CONTENTS, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'nonce-1' })
  })

  it('answers a tab choice with the tab\'s top frame, and its audio only when the page asked and the person ticked it', () => {
    expect(run(TAB).answers).toEqual([{ video: SHOWN_FRAME }])
    expect(run(TAB, { audioRequested: true }).answers).toEqual([{ video: SHOWN_FRAME, audio: SHOWN_FRAME }])
    expect(run({ ...TAB, audio: false } as DisplayChoice, { audioRequested: true }).answers).toEqual([{ video: SHOWN_FRAME }])
  })

  it('gives system audio only on Windows, where Electron can capture it, and only when asked', () => {
    expect(run(SCREEN, { audioRequested: true }, { platform: 'win32' }).answers).toEqual([{ video: { id: 'screen:0:0', name: 'Entire screen' }, audio: 'loopback' }])
    expect(run(SCREEN, { audioRequested: true }, { platform: 'linux' }).answers).toEqual([{ video: { id: 'screen:0:0', name: 'Entire screen' } }])
    expect(run(SCREEN, { audioRequested: false }, { platform: 'win32' }).answers[0]).not.toHaveProperty('audio')
  })

  it('answers no stream, and starts no share, when the frame holds no ticket', () => {
    const { answers, start } = run(undefined)
    expect(answers).toEqual([{}])
    expect(start).not.toHaveBeenCalled()
  })

  it('answers no stream for a request that names no frame, or a frame that is not the tab\'s top frame', () => {
    expect(run(SCREEN, {}, { frame: null }).answers).toEqual([{}])
    const other = run(SCREEN, {}, { frame: { processId: 10, routingId: 7 } })
    expect(other.answers).toEqual([{}])
    expect(other.consume).not.toHaveBeenCalled()
  })

  it('answers no stream when the tab to show was closed while the person picked', () => {
    const closed = { id: 2, mainFrame: {}, isDestroyed: () => true } as never
    const { answers, start } = run({ kind: 'tab', tab: closed, audio: false, label: 'gone' })
    expect(answers).toEqual([{}])
    expect(start).not.toHaveBeenCalled()
  })
})

describe('streamsFor', () => {
  it('reports the audio the page really got', () => {
    expect(streamsFor(TAB, true, 'linux')?.audio).toBe(true)
    expect(streamsFor(SCREEN, true, 'linux')?.audio).toBe(false)
  })
})
