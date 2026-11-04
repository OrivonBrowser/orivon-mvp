import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { infoDomain } from '../about-domain.js'
import type { GpuReading } from '../about-domain.js'
import type { AboutFacts } from '../about-info.js'

const FACTS: AboutFacts = {
  orivon: '1.0.0', commit: 'abc', electron: '44', chromium: '152', node: '24', v8: '15', platform: 'linux', osVersion: '6', arch: 'x64',
  language: 'en', userAgent: 'UA', commandLine: 'orivon', programPath: '/o', profilePath: '/p', downloadsPath: '/d', isPrivate: false
}
const CALLER = {} as InternalCaller
const RELEASE = { version: '1.0.0', notes: { version: '1.0.0', sections: [{ heading: 'Added', items: ['**A**: b'] }] } }

const READING: GpuReading = { status: { webgl: 'enabled' }, info: { gpuDevice: [{ active: true, vendorId: 0x8086 }] }, platform: 'linux', session: 'x11', ozone: 'x11' }

function setup (gpu: () => Promise<GpuReading> = async () => READING): {
  call: (command: unknown) => Promise<unknown>, copy: ReturnType<typeof vi.fn>
} {
  const copy = vi.fn()
  const domain = infoDomain({ facts: () => FACTS, gpu, copy, release: () => RELEASE })
  return { call: async (command) => await domain.handle(command, CALLER), copy }
}

describe('the About domain', () => {
  it('is for the About page alone', () => {
    expect(infoDomain({ facts: () => FACTS, gpu: async () => ({ ...READING, status: {}, info: {} }), copy: () => {}, release: () => RELEASE }).pages).toEqual(['about'])
  })

  it('answers what this version changed, and an empty list for a build with no notes', async () => {
    expect(await setup().call({ type: 'whatsnew' })).toEqual({ version: '1.0.0', sections: [{ heading: 'Added', items: ['**A**: b'] }] })
    const bare = infoDomain({ facts: () => FACTS, gpu: async () => ({ ...READING, status: {}, info: {} }), copy: () => {}, release: () => ({ version: '0.0.0', notes: null }) })
    expect(await bare.handle({ type: 'whatsnew' }, CALLER)).toEqual({ version: '0.0.0', sections: [] })
  })

  it('answers the version table', async () => {
    const reply = await setup().call({ type: 'version' }) as { rows: Array<{ label: string }> }
    expect(reply.rows[0]?.label).toBe('Orivon')
    expect(reply.rows).toHaveLength(13)
  })

  it('answers the graphics report with features, devices and the raw text', async () => {
    const reply = await setup().call({ type: 'gpu' }) as { ok: boolean, features: unknown[], devices: unknown[], devicesKnown: boolean, raw: string }
    expect(reply.ok).toBe(true)
    expect(reply.features).toHaveLength(1)
    expect(reply.devices).toHaveLength(1)
    expect(reply.devicesKnown).toBe(true)
    expect(reply.raw).toContain('featureStatus')
  })

  it('keeps the feature table when the device query gave nothing, and says the devices are not known', async () => {
    const reply = await setup(async () => ({ ...READING, info: undefined })).call({ type: 'gpu' }) as { ok: boolean, devices: unknown[], devicesKnown: boolean }
    expect(reply).toMatchObject({ ok: true, devices: [], devicesKnown: false })
  })

  it('says it failed when the graphics query throws', async () => {
    expect(await setup(async () => { throw new Error('no gpu') }).call({ type: 'gpu' })).toEqual({ ok: false })
  })

  describe('the WebGPU answer', () => {
    const OFF = { webgpu: 'disabled_off', webgpu_on_vk_via_gl_interop: 'disabled_off', gpu_compositing: 'enabled' }
    const reading = (over: Partial<GpuReading>) => async (): Promise<GpuReading> => ({
      status: OFF,
      info: { gpuDevice: [{ active: true, vendorId: 0x10de, driverVendor: 'NVIDIA', driverVersion: '535.1' }] },
      platform: 'linux',
      session: 'x11',
      ozone: 'x11',
      ...over
    })

    it('says what the X11 setting did, when the reading carries it', async () => {
      const x11 = (x11Vulkan: { onAtStart: boolean, reverted: boolean }): GpuReading => ({ ...READING, session: 'x11', ozone: 'x11', status: { webgpu: 'enabled', gpu_compositing: 'enabled' }, x11Vulkan })
      expect(await setup(async () => x11({ onAtStart: true, reverted: false })).call({ type: 'webgpu', adapter: { kind: 'none' } })).toMatchObject({ reason: 'x11-vulkan-no-adapter', tone: 'warn' })
      expect(await setup(async () => x11({ onAtStart: false, reverted: true })).call({ type: 'webgpu' })).toMatchObject({ reason: 'x11-vulkan-reverted', tone: 'warn' })
    })

    it('leaves the way to turn the X11 setting on out of a private window\'s sentence, where the switch is locked', async () => {
      const reply = await setup(reading({ isPrivate: true })).call({ type: 'webgpu' }) as { sentence: string }
      expect(reply.sentence).toBe('WebGPU is off because this computer runs an X11 session. Chromium turns it off there for every graphics card.')
    })

    it('gives the state, the reason, the sentence and the badge colour, for the platform the reading names', async () => {
      expect(await setup(reading({})).call({ type: 'webgpu' })).toEqual({
        ok: true,
        state: 'unavailable',
        reason: 'x11',
        sentence: 'WebGPU is off because this computer runs an X11 session. Chromium turns it off there for every graphics card. You can turn it on in Settings, under Performance.',
        tone: 'neutral'
      })
    })

    it('says it works when the page got an adapter, and trusts nothing else the page sends', async () => {
      expect(await setup(reading({})).call({ type: 'webgpu', adapter: { kind: 'adapter', reason: 'x11', state: 'unknown' } })).toEqual({
        ok: true, state: 'available', reason: 'adapter', sentence: 'WebGPU works on this computer.', tone: 'ok'
      })
      expect(await setup(reading({})).call({ type: 'webgpu', adapter: { kind: 'working' } })).toMatchObject({ reason: 'x11' })
    })

    it('names the graphics card on Wayland once a page got no adapter, and tells XWayland from an X11 session', async () => {
      const wayland = reading({ session: 'wayland', ozone: 'wayland' })
      expect(await setup(wayland).call({ type: 'webgpu', adapter: { kind: 'none' } })).toMatchObject({ state: 'unavailable', reason: 'gpu-not-listed' })
      const listed = reading({ status: { webgpu: 'enabled', gpu_compositing: 'enabled' }, session: 'wayland', ozone: 'wayland' })
      expect(await setup(listed).call({ type: 'webgpu' })).toMatchObject({ state: 'unknown', reason: 'unknown' })
      expect(await setup(reading({ session: 'wayland' })).call({ type: 'webgpu' })).toMatchObject({ state: 'unavailable', reason: 'xwayland' })
    })

    it('colours a page\'s empty answer as a warning, since nothing in the report explains it', async () => {
      const working = reading({ status: { webgpu: 'enabled', webgpu_on_vk_via_gl_interop: 'enabled', gpu_compositing: 'enabled' }, session: '', ozone: '' })
      expect(await setup(working).call({ type: 'webgpu', adapter: { kind: 'none' } })).toMatchObject({ reason: 'no-adapter', tone: 'warn' })
    })

    it('says it failed when the graphics query throws', async () => {
      expect(await setup(async () => { throw new Error('no gpu') }).call({ type: 'webgpu' })).toEqual({ ok: false })
    })
  })

  describe('the graphics reading', () => {
    const counted = (): { gpu: () => Promise<GpuReading>, reads: () => number } => {
      let reads = 0
      return { gpu: async () => { reads += 1; return READING }, reads: () => reads }
    }

    it('is taken once for the report and WebGPU\'s answer the Graphics tab asks for together', async () => {
      const { gpu, reads } = counted()
      const { call } = setup(gpu)
      await Promise.all([call({ type: 'gpu' }), call({ type: 'webgpu' })])
      await call({ type: 'webgpu', adapter: { kind: 'none' } })
      expect(reads()).toBe(1)
    })

    it('is taken again once the last one is old, so Try again reads the computer anew', async () => {
      vi.useFakeTimers()
      try {
        const { gpu, reads } = counted()
        const { call } = setup(gpu)
        await call({ type: 'gpu' })
        await vi.advanceTimersByTimeAsync(2_500)
        await call({ type: 'gpu' })
        expect(reads()).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('is not kept when it failed, so the next request tries again at once', async () => {
      let reads = 0
      const { call } = setup(async () => { reads += 1; if (reads === 1) throw new Error('no gpu'); return READING })
      expect(await call({ type: 'gpu' })).toEqual({ ok: false })
      expect(await call({ type: 'gpu' })).toMatchObject({ ok: true })
      expect(reads).toBe(2)
    })
  })

  it('copies the table it builds itself, for "version"', async () => {
    const { call, copy } = setup()
    expect(await call({ type: 'copy', what: 'version' })).toEqual({ ok: true })
    expect(copy).toHaveBeenCalledOnce()
    expect(String(copy.mock.calls[0]?.[0]).split('\n')[0]).toBe('Orivon: 1.0.0')
  })

  it('copies the raw graphics report for "gpu", and nothing when that cannot be read', async () => {
    const { call, copy } = setup()
    await call({ type: 'copy', what: 'gpu' })
    expect(String(copy.mock.calls[0]?.[0])).toContain('featureStatus')
    const broken = setup(async () => { throw new Error('x') })
    expect(await broken.call({ type: 'copy', what: 'gpu' })).toEqual({ ok: false })
    expect(broken.copy).not.toHaveBeenCalled()
  })

  it('refuses a copy of anything but the two known things, and a command it does not know', async () => {
    const { call, copy } = setup()
    expect(await call({ type: 'copy', what: 'clipboard' })).toBeUndefined()
    expect(await call({ type: 'copy', what: { toString: () => 'version' } })).toBeUndefined()
    expect(await call({ type: 'copy', text: 'evil' })).toBeUndefined()
    expect(await call({ type: 'other' })).toBeUndefined()
    expect(await call(null)).toBeUndefined()
    expect(copy).not.toHaveBeenCalled()
  })
})
