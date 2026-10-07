import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { infoDomain } from '../about-domain.js'
import type { AboutFacts } from '../about-info.js'

const FACTS: AboutFacts = {
  orivon: '1.0.0', commit: 'abc', electron: '44', chromium: '152', node: '24', v8: '15', platform: 'linux', osVersion: '6', arch: 'x64',
  language: 'en', userAgent: 'UA', commandLine: 'orivon', programPath: '/o', profilePath: '/p', downloadsPath: '/d', isPrivate: false
}
const CALLER = {} as InternalCaller

function setup (gpu: () => Promise<{ status: unknown, info: unknown }> = async () => ({ status: { webgl: 'enabled' }, info: { gpuDevice: [{ active: true, vendorId: 0x8086 }] } })): {
  call: (command: unknown) => Promise<unknown>, copy: ReturnType<typeof vi.fn>
} {
  const copy = vi.fn()
  const domain = infoDomain({ facts: () => FACTS, gpu, copy })
  return { call: async (command) => await domain.handle(command, CALLER), copy }
}

describe('the About domain', () => {
  it('is for the About page alone', () => {
    expect(infoDomain({ facts: () => FACTS, gpu: async () => ({ status: {}, info: {} }), copy: () => {} }).pages).toEqual(['about'])
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
    const reply = await setup(async () => ({ status: { webgl: 'enabled' }, info: undefined })).call({ type: 'gpu' }) as { ok: boolean, devices: unknown[], devicesKnown: boolean }
    expect(reply).toMatchObject({ ok: true, devices: [], devicesKnown: false })
  })

  it('says it failed when the graphics query throws', async () => {
    expect(await setup(async () => { throw new Error('no gpu') }).call({ type: 'gpu' })).toEqual({ ok: false })
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
