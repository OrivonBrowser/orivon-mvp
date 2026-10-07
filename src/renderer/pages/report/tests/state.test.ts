import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrivonInternal } from '../../shared/bridge.js'
import { PREVIEW_DELAY_MS, ReportState } from '../state.js'

interface Call { type: string }

function bridge (info: Record<string, unknown>, previews: Array<() => Promise<unknown>>): { bridge: OrivonInternal, calls: Call[] } {
  const calls: Call[] = []
  let index = 0
  return {
    calls,
    bridge: {
      page: 'report',
      platform: 'linux',
      onEvent: () => () => {},
      request: async (_domain, command) => {
        const { type } = command as Call
        calls.push({ type })
        if (type === 'state') return info
        if (type === 'preview') { const next = previews[Math.min(index, previews.length - 1)]; index += 1; return await next?.() }
        return undefined
      }
    }
  }
}

const INFO = { private: false, limits: { description: 100, contact: 10 }, crashes: [], sent: [] }
const READY = async (): Promise<unknown> => ({ text: '{}', sendable: true, bytes: 2 })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('a private session', () => {
  it('starts with the log unticked, and a normal one with it ticked', async () => {
    const priv = new ReportState(bridge({ ...INFO, private: true }, [READY]).bridge)
    await priv.load(null)
    expect(priv.choices.log).toBe(false)
    const open = new ReportState(bridge(INFO, [READY]).bridge)
    await open.load(null)
    expect(open.choices.log).toBe(true)
  })

  it('keeps the person\'s own tick when the form loads again', async () => {
    const state = new ReportState(bridge({ ...INFO, private: true }, [READY]).bridge)
    await state.load(null)
    state.choices.log = true
    await state.load(null)
    expect(state.choices.log).toBe(true)
  })
})

describe('Send', () => {
  it('waits for the preview of the present choices: not while the delay runs, not while it is being asked', async () => {
    let answer: (value: unknown) => void = () => {}
    const slow = async (): Promise<unknown> => await new Promise((resolve) => { answer = resolve })
    const state = new ReportState(bridge(INFO, [READY, slow]).bridge)
    await state.load(null)
    expect(state.canSend).toBe(true)
    state.set({ description: 'x' })
    expect(state.canSend).toBe(false)
    await vi.advanceTimersByTimeAsync(PREVIEW_DELAY_MS)
    expect(state.canSend).toBe(false)
    answer({ text: '{"x":1}', sendable: true, bytes: 7 })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.canSend).toBe(true)
    expect(state.preview?.bytes).toBe(7)
  })

  it('does not go while a preview is pending, even when called directly', async () => {
    const harness = bridge(INFO, [READY])
    const state = new ReportState(harness.bridge)
    await state.load(null)
    state.set({ description: 'x' })
    await state.send()
    expect(harness.calls.some((call) => call.type === 'send')).toBe(false)
  })
})
