import { describe, expect, it } from 'vitest'
import { MAX_NAMED_DIFFERENCES, ddocVerdict } from '../ddoc.js'
import type { PinnedTree, PublishedTree } from '../ddoc.js'

const ROOT = 'sha256:' + 'a'.repeat(64)
const OTHER_ROOT = 'sha256:' + 'b'.repeat(64)
const leaf = (char: string): string => 'sha256:' + char.repeat(64)

const PIN: PinnedTree = {
  bundleHash: ROOT,
  assets: [
    { path: '/.well-known/orivon.json', leaf: leaf('1') },
    { path: '/index.html', leaf: leaf('2') },
    { path: '/app.js', leaf: leaf('3') }
  ]
}

function published (overrides: Partial<PublishedTree> = {}): PublishedTree {
  return { bundleHash: ROOT, leaves: PIN.assets, ...overrides }
}

describe('ddocVerdict', () => {
  it('not checked when nothing is pinned, whatever the site published', () => {
    expect(ddocVerdict(null, published())).toEqual({ status: 'not-checked' })
    expect(ddocVerdict(null, undefined)).toEqual({ status: 'not-checked' })
  })

  it('not published when the site published no readable tree', () => {
    expect(ddocVerdict(PIN, undefined)).toEqual({ status: 'not-published' })
  })

  it('verified when the root and every leaf match, in any order', () => {
    expect(ddocVerdict(PIN, published({ leaves: [...PIN.assets].reverse() }))).toEqual({ status: 'verified' })
  })

  it('failed, naming the file, when one leaf differs', () => {
    const leaves = PIN.assets.map((a) => a.path === '/app.js' ? { ...a, leaf: leaf('9') } : a)
    expect(ddocVerdict(PIN, published({ bundleHash: OTHER_ROOT, leaves }))).toEqual({
      status: 'failed', differing: ['/app.js'], differingCount: 1, rootMatches: false
    })
  })

  it('failed for a file received but not published, and one published but not received', () => {
    const leaves = [...PIN.assets.filter((a) => a.path !== '/app.js'), { path: '/extra.js', leaf: leaf('4') }]
    const verdict = ddocVerdict(PIN, published({ bundleHash: OTHER_ROOT, leaves }))
    expect(verdict).toEqual({ status: 'failed', differing: ['/app.js', '/extra.js'], differingCount: 2, rootMatches: false })
  })

  // A tree stored for an earlier bundle: its root is the old one, so it
  // can only fail against the current pin, never read as verified.
  it('failed when every leaf matches but the published root does not -- the file contradicts itself', () => {
    expect(ddocVerdict(PIN, published({ bundleHash: OTHER_ROOT }))).toEqual({
      status: 'failed', differing: [], differingCount: 0, rootMatches: false
    })
  })

  it('failed when the root matches but a leaf does not -- a provider reading the table would be misled', () => {
    const leaves = PIN.assets.map((a) => a.path === '/index.html' ? { ...a, leaf: leaf('8') } : a)
    const verdict = ddocVerdict(PIN, published({ leaves }))
    expect(verdict).toEqual({ status: 'failed', differing: ['/index.html'], differingCount: 1, rootMatches: true })
  })

  it('names at most MAX_NAMED_DIFFERENCES files, sorted, and counts them all', () => {
    const extra = Array.from({ length: MAX_NAMED_DIFFERENCES + 5 }, (_, i) => ({ path: `/x${String(i).padStart(3, '0')}.js`, leaf: leaf('5') }))
    const verdict = ddocVerdict(PIN, published({ leaves: [...PIN.assets, ...extra] }))
    expect(verdict.status).toBe('failed')
    if (verdict.status !== 'failed') return
    expect(verdict.differingCount).toBe(MAX_NAMED_DIFFERENCES + 5)
    expect(verdict.differing).toEqual(extra.slice(0, MAX_NAMED_DIFFERENCES).map((e) => e.path))
  })
})
