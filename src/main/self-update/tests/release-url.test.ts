import { describe, expect, it } from 'vitest'
import { parseOmniboxInput } from '../../browsing/omnibox.js'
import { LATEST_RELEASE_NAME, LATEST_RELEASE_URL, RELEASES_URL, releaseUrl } from '../release-url.js'

describe('releaseUrl', () => {
  it('is the page of a release whose tag looks like a version', () => {
    expect(releaseUrl('v1.2.3')).toBe(`${RELEASES_URL}/tag/v1.2.3`)
    expect(releaseUrl('0.4.0-beta.1')).toBe(`${RELEASES_URL}/tag/0.4.0-beta.1`)
  })

  it('is the list of releases for a tag that does not, or for none', () => {
    for (const tag of [null, '', 'latest', 'v1.2', '../../evil', 'https://evil.example/', 'x1.2.3']) expect(releaseUrl(tag), String(tag)).toBe(RELEASES_URL)
  })

  it('never names another host, whatever follows a valid-looking tag', () => {
    const url = releaseUrl('v1.2.3/../../../../evil.example?x=1#y')
    expect(new URL(url).host).toBe('github.com')
    expect(url.startsWith(`${RELEASES_URL}/tag/`)).toBe(true)
    expect(url).not.toContain('evil.example/')
  })
})

describe('the newest-release name', () => {
  it('is the address the address bar makes of latest.orivonstack.eth, so a typed name and the button cannot drift apart', () => {
    expect(LATEST_RELEASE_NAME).toBe('latest.orivonstack.eth')
    expect(parseOmniboxInput(LATEST_RELEASE_NAME, () => false)).toEqual({ kind: 'url', url: LATEST_RELEASE_URL })
    expect(LATEST_RELEASE_URL).toBe('https://latest.orivonstack.eth/')
  })
})
