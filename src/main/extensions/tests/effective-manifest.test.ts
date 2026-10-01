import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXTENSION_PREFS } from '../extension-prefs.js'

const order: string[] = []
vi.mock('../manifest-stage-granted.js', () => ({
  applyGrantedStage: (manifest: Record<string, unknown>) => { order.push('granted'); return { ...manifest, stages: [...(manifest['stages'] as string[] ?? []), 'granted'] } }
}))
vi.mock('../manifest-stage-site-access.js', () => ({
  applySiteAccessStage: (manifest: Record<string, unknown>) => { order.push('siteAccess'); return { ...manifest, stages: [...(manifest['stages'] as string[] ?? []), 'siteAccess'] } }
}))

const { effectiveManifest, manifestText, MANIFEST_STAGES } = await import('../effective-manifest.js')

describe('effectiveManifest', () => {
  it('runs the granted stage, then the site-access stage, each on the last one\'s output', () => {
    const out = effectiveManifest({ name: 'x' }, DEFAULT_EXTENSION_PREFS)
    expect(out).toEqual({ name: 'x', stages: ['granted', 'siteAccess'] })
    expect(order).toEqual(['granted', 'siteAccess'])
    expect(MANIFEST_STAGES).toHaveLength(2)
  })
})

describe('manifestText', () => {
  it('is the serialisation an install writes, so equal manifests compare equal as text', () => {
    expect(manifestText({ a: 1, b: [2] })).toBe(JSON.stringify({ a: 1, b: [2] }))
  })
})
