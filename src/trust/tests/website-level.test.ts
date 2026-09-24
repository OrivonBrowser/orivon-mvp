import { describe, expect, it } from 'vitest'
import { websiteLevel } from '../website-level.js'

const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const HASH = 'sha256:' + 'a'.repeat(64)

describe('websiteLevel', () => {
  it('is Level 2 for a .eth page whose every pointer and byte was verified, and names its CID', () => {
    expect(websiteLevel({ source: 'live', cid: CID, ddoc: 'met' }, undefined)).toMatchObject({ level: 2, assessable: { kind: 'cid', value: CID } })
  })

  it('is Level 2 for an installed .eth app whose pointers were verified', () => {
    expect(websiteLevel({ source: 'pinned', cid: CID, pointersVerified: true }, HASH)).toMatchObject({ level: 2, assessable: { kind: 'cid', value: CID } })
  })

  it('is Level 1 through a DNSLink, live or installed, and says why', () => {
    const live = websiteLevel({ source: 'live', cid: CID, ddoc: 'not-met', reason: 'via DNS: app.example' }, undefined)
    expect(live.level).toBe(1)
    expect(live.because).toContain('via DNS: app.example')
    expect(websiteLevel({ source: 'pinned', cid: CID, pointersVerified: false }, HASH).level).toBe(1)
  })

  it('is Level 1, and says something may be tampering, when a file failed its check everywhere', () => {
    const failed = websiteLevel({ source: 'live', cid: CID, ddoc: 'failed', reason: '/app.js' }, undefined)
    expect(failed.level).toBe(1)
    expect(failed.because).toMatch(/\/app\.js.*tampering/)
  })

  it('is Level 1 for an ordinary site, pinned or not, naming the bundle hash only when there is one', () => {
    expect(websiteLevel(undefined, HASH)).toMatchObject({ level: 1, assessable: { kind: 'bundle-hash', value: HASH } })
    expect(websiteLevel(undefined, undefined)).toEqual({ level: 1, because: expect.any(String), assessable: undefined })
  })
})
