import { describe, expect, it, vi } from 'vitest'
import type { OrivonInternal } from '../../shared/bridge.js'
import { AboutState } from '../state.js'
import type { AdapterProbe } from '../webgpu-probe.js'

function bridge (reply: unknown): { bridge: OrivonInternal, request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => reply)
  return { bridge: { page: 'about', request, onEvent: () => () => {}, platform: 'linux' }, request }
}

const SENTENCE = 'WebGPU is off because this computer runs an X11 session. Chromium turns it off there for every graphics card.'

describe('AboutState.loadWebGpu', () => {
  it('tells main only which outcome the page saw, and keeps the adapter\'s own words for itself', async () => {
    const { bridge: b, request } = bridge({ ok: true, state: 'available', reason: 'adapter', sentence: 'WebGPU works on this computer.' })
    const state = new AboutState(b, async (): Promise<AdapterProbe> => ({ kind: 'adapter', vendor: 'intel', architecture: 'xe-lpg' }))
    await state.loadWebGpu()
    expect(request).toHaveBeenCalledWith('info', { type: 'webgpu', adapter: { kind: 'adapter' } })
    expect(state.webGpu).toEqual({ state: 'ready', value: { state: 'available', sentence: 'WebGPU works on this computer.', vendor: 'intel', architecture: 'xe-lpg' } })
  })

  it('shows main\'s sentence and no adapter when the page got none', async () => {
    const { bridge: b, request } = bridge({ ok: true, state: 'unavailable', reason: 'x11', sentence: SENTENCE })
    const state = new AboutState(b, async (): Promise<AdapterProbe> => ({ kind: 'none' }))
    await state.loadWebGpu()
    expect(request).toHaveBeenCalledWith('info', { type: 'webgpu', adapter: { kind: 'none' } })
    expect(state.webGpu).toEqual({ state: 'ready', value: { state: 'unavailable', sentence: SENTENCE, vendor: '', architecture: '' } })
  })

  it('is an error for an answer that is not one of the three states, or when main failed or the request threw', async () => {
    const none = async (): Promise<AdapterProbe> => ({ kind: 'no-api' })
    for (const reply of [{ ok: true, state: 'maybe', sentence: 'x' }, { ok: false }, undefined, { ok: true, state: 'unknown' }]) {
      const state = new AboutState(bridge(reply).bridge, none)
      await state.loadWebGpu()
      expect(state.webGpu).toEqual({ state: 'error' })
    }
    const throwing = new AboutState({ page: 'about', request: async () => { throw new Error('closed') }, onEvent: () => () => {}, platform: 'linux' }, none)
    await throwing.loadWebGpu()
    expect(throwing.webGpu).toEqual({ state: 'error' })
  })

  it('says it is loading while it waits, and tells the page each time it changes', async () => {
    const { bridge: b } = bridge({ ok: true, state: 'unknown', sentence: 'x' })
    const state = new AboutState(b, async (): Promise<AdapterProbe> => ({ kind: 'none' }))
    const seen: string[] = []
    state.onChange(() => { seen.push(state.webGpu?.state ?? 'null') })
    await state.loadWebGpu()
    expect(seen).toEqual(['loading', 'ready'])
  })
})
