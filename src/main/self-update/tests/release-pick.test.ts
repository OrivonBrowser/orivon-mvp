import { describe, expect, it } from 'vitest'
import { MANIFEST_ASSET, pickRelease, SIGNATURE_ASSET } from '../release-pick.js'

const SIGNED = [{ name: MANIFEST_ASSET }, { name: SIGNATURE_ASSET }, { name: 'Orivon-1.0.0-x86_64.AppImage' }]
const release = (tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ tag_name: tag, name: tag, draft: false, prerelease: false, assets: SIGNED, ...extra })

describe('pickRelease', () => {
  it('answers the highest signed stable release, whatever the order of the list', () => {
    expect(pickRelease([release('v1.0.0'), release('v1.2.0'), release('v1.1.9')])).toEqual({ tag: 'v1.2.0', version: '1.2.0' })
  })

  it('compares versions, not strings', () => {
    expect(pickRelease([release('v1.9.0'), release('v1.10.0')])?.version).toBe('1.10.0')
  })

  it('skips a nightly by tag or by name, even a newer one published as a full release', () => {
    expect(pickRelease([release('v1.1.0'), release('v1.3.0-nightly.4'), release('v1.2.0', { name: 'Nightly build' })])?.tag).toBe('v1.1.0')
  })

  it('skips a prerelease flag, a semver prerelease part and a draft', () => {
    const list = [release('v1.0.0'), release('v2.0.0', { prerelease: true }), release('v2.1.0-rc.1'), release('v2.2.0', { draft: true })]
    expect(pickRelease(list)?.tag).toBe('v1.0.0')
  })

  it('offers the older signed release while the newest one is not signed yet', () => {
    const unsigned = release('v1.3.0', { assets: [{ name: MANIFEST_ASSET }, { name: 'Orivon-1.3.0-x86_64.AppImage' }] })
    expect(pickRelease([unsigned, release('v1.2.0')])?.tag).toBe('v1.2.0')
  })

  it('refuses a tag that is more than a version, so no address built from it can differ in shape', () => {
    expect(pickRelease([release('v1.2.0+meta'), release('v1.2'), release('1.2.0/../x'), release('v1.2.0 ')])).toBeNull()
  })

  it('answers null for no release, a list it cannot read, and entries of the wrong shape', () => {
    expect(pickRelease([])).toBeNull()
    expect(pickRelease(null)).toBeNull()
    expect(pickRelease({ tag_name: 'v1.0.0' })).toBeNull()
    expect(pickRelease([null, 3, 'v1.0.0', { tag_name: 7 }, { tag_name: 'v1.0.0', assets: 'x' }])).toBeNull()
  })

  it('takes a tag with no v as it is', () => {
    expect(pickRelease([release('1.4.0')])).toEqual({ tag: '1.4.0', version: '1.4.0' })
  })
})
