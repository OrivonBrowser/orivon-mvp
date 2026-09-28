import { describe, expect, it } from 'vitest'
import { sizeWords } from '../settings/apps-view.js'
import { UpdatesState } from '../settings/updates-state.js'
import type { OrivonInternal } from '../shared/bridge.js'

describe('sizeWords', () => {
  it('reads a size as a person would', () => {
    expect(sizeWords(0)).toBe('0 bytes')
    expect(sizeWords(1023)).toBe('1023 bytes')
    expect(sizeWords(1024)).toBe('1.0 KB')
    expect(sizeWords(1536)).toBe('1.5 KB')
    expect(sizeWords(15 * 1024)).toBe('15 KB')
    expect(sizeWords(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(sizeWords(3 * 1024 ** 3)).toBe('3.0 GB')
    expect(sizeWords(5000 * 1024 ** 3)).toBe('5000 GB')
  })
})

function state (reply: unknown): { updates: UpdatesState, changes: number[] } {
  const changes: number[] = []
  const bridge = { request: async () => reply } as unknown as OrivonInternal
  return { updates: new UpdatesState(bridge, () => { changes.push(changes.length) }), changes }
}

describe('what "Check now" says', () => {
  it('is silent before anything is asked', () => {
    expect(state(undefined).updates.words()).toBe('')
  })

  it('says a newer release is there, and which', async () => {
    const { updates, changes } = state({ ok: true, answer: { reached: true, current: '1.0.0', latest: 'v1.1.0', newer: true, url: 'x' } })
    await updates.check()
    expect(updates.words()).toBe('v1.1.0 is available. You have 1.0.0.')
    expect(changes).toHaveLength(2)
  })

  it('says the person is up to date', async () => {
    const { updates } = state({ ok: true, answer: { reached: true, current: '1.1.0', latest: 'v1.1.0', newer: false, url: 'x' } })
    await updates.check()
    expect(updates.words()).toBe('You have the latest release (1.1.0).')
  })

  it('says when it could not reach the list, and when a private window is asked', async () => {
    const offline = state({ ok: true, answer: { reached: false, current: '1.0.0', latest: null, newer: false, url: null } })
    await offline.updates.check()
    expect(offline.updates.words()).toContain('Could not reach')
    const refused = state({ ok: false, reason: 'private' })
    await refused.updates.check()
    expect(refused.updates.words()).toContain('private window')
    const nothing = state(undefined)
    await nothing.updates.check()
    expect(nothing.updates.words()).toContain('private window')
  })
})
