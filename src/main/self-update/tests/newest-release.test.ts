import { describe, expect, it } from 'vitest'
import { pickNewestRelease } from '../newest-release.js'

const release = (tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ tag_name: tag, draft: false, prerelease: true, created_at: '2026-10-01T00:00:00Z', ...extra })

describe('pickNewestRelease', () => {
  it('picks the newest version when every release is a pre-release', () => {
    const list = [release('v0.0.8'), release('v0.0.6'), release('v0.0.5')]
    expect(pickNewestRelease(list)).toEqual({ tag: 'v0.0.8' })
  })

  it('never picks a draft, even a newer one', () => {
    const list = [release('v0.0.9', { draft: true }), release('v0.0.8'), release('v0.0.6')]
    expect(pickNewestRelease(list)?.tag).toBe('v0.0.8')
  })

  it('never picks a tag that is not a version, whatever its date or position', () => {
    const list = [release('pre-releases', { created_at: '2030-01-01T00:00:00Z' }), release('latest'), release('v0.0.8')]
    expect(pickNewestRelease(list)?.tag).toBe('v0.0.8')
    expect(pickNewestRelease([release('pre-releases'), release('nightly')])).toBeNull()
  })

  it('answers null for an empty list', () => {
    expect(pickNewestRelease([])).toBeNull()
  })

  it('answers null for a body it cannot read, and skips entries of the wrong shape', () => {
    for (const body of [null, undefined, 'v1.0.0', 7, {}, { tag_name: 'v1.0.0' }]) expect(pickNewestRelease(body), String(body)).toBeNull()
    expect(pickNewestRelease([null, 3, 'v9.0.0', { tag_name: 7 }, { tag_name: '' }, release('v0.0.4')])?.tag).toBe('v0.0.4')
  })

  it('prefers the full release over a pre-release of the same version, and a higher pre-release over a lower full one', () => {
    expect(pickNewestRelease([release('v1.0.0-rc.1'), release('v1.0.0', { prerelease: false })])?.tag).toBe('v1.0.0')
    expect(pickNewestRelease([release('v1.0.0', { prerelease: false }), release('v1.1.0-rc.1')])?.tag).toBe('v1.1.0-rc.1')
  })

  it('orders by version, not by list order or date', () => {
    const list = [
      release('v0.0.6', { created_at: '2026-12-01T00:00:00Z' }),
      release('v0.0.10', { created_at: '2026-01-01T00:00:00Z' }),
      release('v0.0.8', { created_at: '2026-11-01T00:00:00Z' })
    ]
    expect(pickNewestRelease(list)?.tag).toBe('v0.0.10')
    expect(pickNewestRelease([...list].reverse())?.tag).toBe('v0.0.10')
  })
})
