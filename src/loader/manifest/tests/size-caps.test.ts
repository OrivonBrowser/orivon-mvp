import { describe, expect, it } from 'vitest'
import { MAX_BUNDLE_ENTRIES } from '../../../broker/policy/canonical-path.js'
import { MAX_MANIFEST_BYTES, parseManifest } from '../manifest.js'

/** A built frontend's typical hashed asset name, padded to the per-entry budget MAX_MANIFEST_BYTES is sized from. */
function hashedAssetPath (index: number): string {
  return `assets/vendor-chunk-${String(index).padStart(5, '0')}-3f2a1b9c.module.js`.padEnd(56, 'x')
}

describe('MAX_MANIFEST_BYTES', () => {
  it('fits a manifest declaring every asset slot the bundle allows, at a realistic path length', () => {
    const assets = Array.from({ length: MAX_BUNDLE_ENTRIES - 2 }, (_, i) => hashedAssetPath(i))
    const text = JSON.stringify({
      orivonApiVersion: 0,
      id: 'app.orivon.large',
      name: 'A large built frontend',
      version: '1.0.0',
      entry: 'index.html',
      assets,
      capabilities: { net: { tcp: { connect: ['api.example.com:443'] }, https: { connect: ['cdn.example.com:443'] } } }
    }, null, 2)
    const bytes = new TextEncoder().encode(text).length

    expect(bytes).toBeGreaterThan(64 * 1024)
    expect(bytes).toBeLessThanOrEqual(MAX_MANIFEST_BYTES)
    expect(parseManifest(text).ok).toBe(true)
  })

  it('still rejects a manifest over the cap before parsing it', () => {
    const text = JSON.stringify({ padding: 'x'.repeat(MAX_MANIFEST_BYTES) })
    const result = parseManifest(text)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(`exceeds ${String(MAX_MANIFEST_BYTES)} bytes`)
  })
})
