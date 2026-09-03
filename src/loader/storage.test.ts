import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { appRootDirectoryName } from './storage.js'

// A22 (docs/open-questions.md): the app's on-disk root directory name is
// sha256(canonical_origin), lowercase hex, single-case -- load-bearing for
// the case-SENSITIVE comparison policy/paths.ts's confinePath makes. This
// suite proves appRootDirectoryName actually IS that construction, computed
// by an independent reference implementation (node:crypto's own createHash,
// not the broker's originHash) -- the same "don't trust the implementation
// to grade its own homework" stance bundle-hash.test.ts's frozen vectors
// take.

describe('appRootDirectoryName', () => {
  it('is sha256(utf8(origin)) as lowercase hex, verified independently', () => {
    const origin = 'https://app.example.com'
    const expected = createHash('sha256').update(origin, 'utf8').digest('hex')
    expect(appRootDirectoryName(origin)).toBe(expected)
  })

  it('is single-case hex -- no uppercase character, ever (A22)', () => {
    const name = appRootDirectoryName('https://App.Example.COM:8443')
    expect(name).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs for different origins', () => {
    const a = appRootDirectoryName('https://a.example.com')
    const b = appRootDirectoryName('https://b.example.com')
    expect(a).not.toBe(b)
  })

  it('is exactly 64 hex characters (full SHA-256, not truncated)', () => {
    expect(appRootDirectoryName('https://x.example.com').length).toBe(64)
  })
})
