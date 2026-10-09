import { describe, expect, it } from 'vitest'
import { judgeBundle, visitKind } from '../first-visit-decisions.js'

const leaf = (character: string): string => `sha256:${character.repeat(64)}`
const TREE = { root: leaf('r'), assets: [{ path: '/index.html', leaf: leaf('a') }, { path: '/app.js', leaf: leaf('b') }] }

describe('visitKind', () => {
  const never = { registered: false, pinned: false, versionFloor: '0.0.0', declined: false }

  it('is first for an origin Orivon has never held', () => {
    expect(visitKind(never)).toBe('first')
  })

  it('is known once the origin is registered, pinned, or has had a version registered', () => {
    expect(visitKind({ ...never, registered: true })).toBe('known')
    expect(visitKind({ ...never, pinned: true })).toBe('known')
    expect(visitKind({ ...never, versionFloor: '0.0.1' })).toBe('known')
  })

  it('is declined when the person said no and holds nothing: the site stays a plain website', () => {
    expect(visitKind({ ...never, declined: true })).toBe('declined')
  })

  it('is known, never declined, for an installed app whose widening the person refused', () => {
    expect(visitKind({ ...never, registered: true, declined: true })).toBe('known')
  })
})

describe('judgeBundle', () => {
  const published = (overrides: Partial<{ bundleHash: string, leaves: Array<{ path: string, leaf: string }> }> = {}): { bundleHash: string, leaves: Array<{ path: string, leaf: string }> } =>
    ({ bundleHash: TREE.root, leaves: [...TREE.assets], ...overrides })

  it('lets a bundle that matches what the site published in', () => {
    expect(judgeBundle(TREE, published())).toEqual({ kind: 'enter', ddoc: 'verified' })
  })

  it('lets a bundle in when the site published nothing to compare with, and says so', () => {
    expect(judgeBundle(TREE, undefined)).toEqual({ kind: 'enter', ddoc: 'not-published' })
  })

  it('blocks a bundle with a file that differs, naming it', () => {
    const verdict = judgeBundle(TREE, published({ leaves: [{ path: '/index.html', leaf: leaf('a') }, { path: '/app.js', leaf: leaf('c') }] }))
    expect(verdict).toEqual({ kind: 'block', differing: ['/app.js'], differingCount: 1, rootMatches: true })
  })

  it('blocks a bundle missing a file the site published, and one with a file the site did not', () => {
    const verdict = judgeBundle(TREE, published({ leaves: [{ path: '/index.html', leaf: leaf('a') }, { path: '/extra.js', leaf: leaf('d') }] }))
    expect(verdict).toEqual({ kind: 'block', differing: ['/app.js', '/extra.js'], differingCount: 2, rootMatches: true })
  })

  it('blocks when every file matches but the published root does not', () => {
    expect(judgeBundle(TREE, published({ bundleHash: leaf('z') }))).toEqual({ kind: 'block', differing: [], differingCount: 0, rootMatches: false })
  })
})
