import { describe, expect, it } from 'vitest'
import type { DdocVerdict } from '../ddoc.js'
import { websiteLevel } from '../website-level.js'

const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const HASH = 'sha256:' + 'a'.repeat(64)
const NOT_CHECKED: DdocVerdict = { status: 'not-checked' }

describe('websiteLevel', () => {
  it('is Level 2 for a .eth page whose every byte was checked, and names its CID', () => {
    expect(websiteLevel({ source: 'live', cid: CID, pointersVerified: true }, NOT_CHECKED, undefined)).toMatchObject({ level: 2, assessable: { kind: 'cid', value: CID } })
  })

  it('is Level 2 for an installed .eth app, whose files were checked when it was installed', () => {
    expect(websiteLevel({ source: 'pinned', cid: CID, pointersVerified: true }, NOT_CHECKED, HASH)).toMatchObject({ level: 2, assessable: { kind: 'cid', value: CID } })
  })

  it('is Level 2 through a DNSLink too, since IPFS content meets DDOC by design, and says the DNS hop is unproven', () => {
    const live = websiteLevel({ source: 'live', cid: CID, pointersVerified: false }, NOT_CHECKED, undefined)
    expect(live.level).toBe(2)
    expect(live.because).toMatch(/DNSLink.*unproven/)
    expect(websiteLevel({ source: 'pinned', cid: CID, pointersVerified: false }, NOT_CHECKED, HASH).level).toBe(2)
  })

  it('is Level 1, and says something may be tampering, when a file failed its check everywhere', () => {
    const failed = websiteLevel({ source: 'live', cid: CID, pointersVerified: true, failedResource: '/app.js' }, NOT_CHECKED, undefined)
    expect(failed.level).toBe(1)
    expect(failed.because).toMatch(/\/app\.js.*tampering/)
  })

  it('is Level 2 for an installed HTTPS site whose files match the hash tree it publishes, and names its bundle hash', () => {
    expect(websiteLevel(undefined, { status: 'verified' }, HASH)).toMatchObject({ level: 2, assessable: { kind: 'bundle-hash', value: HASH } })
  })

  it('is Level 1 for an HTTPS site whose tree fails, is not published, or was never checked', () => {
    for (const ddoc of [{ status: 'failed', differing: ['/a.js'], differingCount: 1 }, { status: 'not-published' }, NOT_CHECKED] as DdocVerdict[]) {
      expect(websiteLevel(undefined, ddoc, HASH).level).toBe(1)
    }
    expect(websiteLevel(undefined, NOT_CHECKED, undefined)).toEqual({ level: 1, because: expect.any(String), assessable: undefined })
  })
})
