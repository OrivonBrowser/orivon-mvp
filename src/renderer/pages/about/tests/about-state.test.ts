import { describe, expect, it, vi } from 'vitest'
import type { OrivonInternal } from '../../shared/bridge.js'
import { AboutState } from '../state.js'
import type { AdapterProbe } from '../../shared/webgpu-probe.js'

function bridge (reply: unknown): { bridge: OrivonInternal, request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => reply)
  return { bridge: { page: 'about', request, onEvent: () => () => {}, platform: 'linux' }, request }
}

const SENTENCE = 'WebGPU is off because this computer runs an X11 session. Chromium turns it off there for every graphics card.'
const GPU_REPLY = { ok: true, features: [], devices: [], devicesKnown: true, raw: '{}' }

describe('AboutState.loadWebGpu', () => {
  it('tells main only which outcome the page saw, and keeps the adapter\'s own words for itself', async () => {
    const { bridge: b, request } = bridge({ ok: true, state: 'available', reason: 'adapter', sentence: 'WebGPU works on this computer.' })
    const state = new AboutState(b, async (): Promise<AdapterProbe> => ({ kind: 'adapter', vendor: 'intel', architecture: 'xe-lpg' }))
    await state.loadWebGpu()
    expect(request).toHaveBeenCalledWith('info', { type: 'webgpu', adapter: { kind: 'adapter' } })
    expect(state.webGpu).toEqual({ state: 'ready', value: { state: 'available', sentence: 'WebGPU works on this computer.', tone: 'neutral', vendor: 'intel', architecture: 'xe-lpg' } })
  })

  it('shows main\'s sentence and no adapter when the page got none', async () => {
    const { bridge: b, request } = bridge({ ok: true, state: 'unavailable', reason: 'x11', sentence: SENTENCE, tone: 'warn' })
    const state = new AboutState(b, async (): Promise<AdapterProbe> => ({ kind: 'none' }))
    await state.loadWebGpu()
    expect(request).toHaveBeenCalledWith('info', { type: 'webgpu', adapter: { kind: 'none' } })
    expect(state.webGpu).toEqual({ state: 'ready', value: { state: 'unavailable', sentence: SENTENCE, tone: 'warn', vendor: '', architecture: '' } })
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

  it('takes the badge colour main chose, and a neutral one for any other word', async () => {
    for (const [tone, expected] of [['ok', 'ok'], ['danger', 'danger'], ['purple', 'neutral'], [undefined, 'neutral']] as const) {
      const state = new AboutState(bridge({ ok: true, state: 'unavailable', sentence: SENTENCE, tone }).bridge, async (): Promise<AdapterProbe> => ({ kind: 'none' }))
      await state.loadWebGpu()
      expect(state.webGpu).toMatchObject({ state: 'ready', value: { tone: expected } })
    }
  })

  it('tells main nothing when the browser did not answer in time, and still shows main\'s sentence', async () => {
    const { bridge: b, request } = bridge({ ok: true, state: 'unknown', sentence: 'Orivon cannot tell.', tone: 'neutral' })
    const state = new AboutState(b, async (): Promise<AdapterProbe> => ({ kind: 'unread' }))
    await state.loadWebGpu()
    expect(request).toHaveBeenCalledWith('info', { type: 'webgpu' })
    expect(state.webGpu).toMatchObject({ state: 'ready', value: { state: 'unknown', sentence: 'Orivon cannot tell.' } })
  })
})

describe('AboutState.reloadGraphics', () => {
  it('asks again for both the report and WebGPU\'s answer, so one Try again mends either', async () => {
    const request = vi.fn(async (_domain: string, command: unknown) => (command as { type: string }).type === 'gpu' ? GPU_REPLY : { ok: true, state: 'unknown', sentence: 'x', tone: 'neutral' })
    const state = new AboutState({ page: 'about', request, onEvent: () => () => {}, platform: 'linux' }, async (): Promise<AdapterProbe> => ({ kind: 'none' }))
    state.gpu = { state: 'error' }
    state.webGpu = { state: 'error' }
    await state.reloadGraphics()
    expect(state.gpu?.state).toBe('ready')
    expect(state.webGpu?.state).toBe('ready')
    expect(request.mock.calls.map((call) => (call[1] as { type: string }).type).sort()).toEqual(['gpu', 'webgpu'])
  })
})
