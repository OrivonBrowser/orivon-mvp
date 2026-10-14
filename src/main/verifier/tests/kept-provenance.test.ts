import { describe, expect, it } from 'vitest'
import { createKeptProvenance } from '../kept-provenance.js'
import type { SiteProvenance } from '../../../protocols/verifier-host/protocol.js'

const provenance = (cid: string, mountedAt = 1, failed?: string): SiteProvenance => ({
  root: { cid },
  pointers: [],
  mountedAt,
  ddoc: failed === undefined ? { status: 'verified', refusals: [] } : { status: 'failed', resource: failed, refusals: [] }
}) as unknown as SiteProvenance

describe('createKeptProvenance', () => {
  it('shows the verifier\'s answer when it has one, and remembers it', () => {
    const kept = createKeptProvenance()
    const fresh = provenance('bafyA')
    expect(kept.resolve('a.eth ', fresh)).toEqual({ provenance: fresh, kept: false })
  })

  it('shows the last answer when the verifier has none now, however often it is asked', () => {
    const kept = createKeptProvenance()
    const fresh = provenance('bafyA')
    kept.resolve('a.eth ', fresh)
    expect(kept.resolve('a.eth ', null)).toEqual({ provenance: fresh, kept: true })
    expect(kept.resolve('a.eth ', null)).toEqual({ provenance: fresh, kept: true })
  })

  it('takes an answer that differs, a moved name or a file that failed its check, at once', () => {
    const kept = createKeptProvenance()
    kept.resolve('a.eth ', provenance('bafyA'))
    const moved = provenance('bafyB', 2)
    expect(kept.resolve('a.eth ', moved)).toEqual({ provenance: moved, kept: false })
    expect(kept.resolve('a.eth ', null).provenance).toBe(moved)
    const tampered = provenance('bafyB', 3, '/app.js')
    kept.resolve('a.eth ', tampered)
    expect(kept.resolve('a.eth ', null).provenance).toBe(tampered)
  })

  it('has nothing to show for a site it never saw, and keeps each key to itself', () => {
    const kept = createKeptProvenance()
    kept.resolve('a.eth ', provenance('bafyA'))
    expect(kept.resolve('b.eth ', null)).toEqual({ provenance: null, kept: false })
    expect(kept.resolve('a.eth tunnel', null)).toEqual({ provenance: null, kept: false })
  })

  it('forgets everything when asked, and the oldest site past its cap', () => {
    const kept = createKeptProvenance(2)
    kept.resolve('1 ', provenance('bafy1'))
    kept.resolve('2 ', provenance('bafy2'))
    kept.resolve('3 ', provenance('bafy3'))
    expect(kept.resolve('1 ', null).provenance).toBeNull()
    expect(kept.resolve('3 ', null).kept).toBe(true)
    kept.forgetAll()
    expect(kept.resolve('3 ', null).provenance).toBeNull()
  })
})
