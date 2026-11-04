import { describe, expect, it } from 'vitest'
import { probeAdapter } from '../webgpu-probe.js'

describe('probeAdapter', () => {
  it('reports the adapter\'s vendor and architecture', async () => {
    const nav = { gpu: { requestAdapter: async () => ({ info: { vendor: 'intel', architecture: 'xe-lpg', device: 'ignored' } }) } }
    expect(await probeAdapter(nav)).toEqual({ kind: 'adapter', vendor: 'intel', architecture: 'xe-lpg' })
  })

  it('reports an adapter that names nothing as one with empty fields', async () => {
    expect(await probeAdapter({ gpu: { requestAdapter: async () => ({}) } })).toEqual({ kind: 'adapter', vendor: '', architecture: '' })
    expect(await probeAdapter({ gpu: { requestAdapter: async () => ({ info: { vendor: 7, architecture: null } }) } })).toEqual({ kind: 'adapter', vendor: '', architecture: '' })
  })

  it('cuts a long name', async () => {
    const reply = await probeAdapter({ gpu: { requestAdapter: async () => ({ info: { vendor: 'x'.repeat(500), architecture: '' } }) } })
    expect(reply).toMatchObject({ kind: 'adapter' })
    expect((reply as { vendor: string }).vendor).toHaveLength(64)
  })

  it('reports none when the browser gives no adapter or the request fails', async () => {
    expect(await probeAdapter({ gpu: { requestAdapter: async () => null } })).toEqual({ kind: 'none' })
    expect(await probeAdapter({ gpu: { requestAdapter: async () => { throw new Error('refused') } } })).toEqual({ kind: 'none' })
  })

  it('reports no API when the page has no WebGPU', async () => {
    expect(await probeAdapter({})).toEqual({ kind: 'no-api' })
  })
})
