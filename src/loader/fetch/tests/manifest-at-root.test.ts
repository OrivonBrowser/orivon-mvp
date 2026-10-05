import { describe, expect, it } from 'vitest'
import { CONTENT_ROOT_HEADER } from '../content-root.js'
import type { Fetch } from '../budget.js'
import { fetchManifestAtRoot } from '../manifest-at-root.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, stubFetch, utf8 } from '../../tests/test-helpers.js'

// Reads only the manifest of the content one root names, for a judgement
// about that content (src/trust/domain-binding.ts): an app, a website, or
// content that could not be read at all.

const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'

describe('fetchManifestAtRoot', () => {
  it('returns the parsed manifest, requested only under the root, and nothing else', async () => {
    const seen: Array<{ url: string, root: string | undefined }> = []
    const inner = stubFetch({ [MANIFEST_URL]: { body: utf8(manifestJson({ domain: 'app.example.com' })) } })
    const fetch: Fetch = async (url, pinned, signal, headers) => {
      seen.push({ url, root: headers?.[CONTENT_ROOT_HEADER] })
      return await inner(url, pinned, signal, headers)
    }
    const result = await fetchManifestAtRoot(fetch, PUBLIC_RESOLVER, ORIGIN, CID)
    expect(result).toMatchObject({ kind: 'app', manifest: { domain: 'app.example.com' } })
    expect(seen).toEqual([{ url: MANIFEST_URL, root: CID }])
  })

  it('answers website for a 404, the only answer that shows the content has no manifest', async () => {
    const fetch = stubFetch({ [MANIFEST_URL]: { status: 404, body: utf8('not found') } })
    expect(await fetchManifestAtRoot(fetch, PUBLIC_RESOLVER, ORIGIN, CID)).toEqual({ kind: 'website' })
  })

  it.each([500, 502, 504])('answers unread for HTTP %i, which proves nothing about the content', async (status) => {
    const fetch = stubFetch({ [MANIFEST_URL]: { status, body: utf8('') } })
    expect(await fetchManifestAtRoot(fetch, PUBLIC_RESOLVER, ORIGIN, CID)).toMatchObject({ kind: 'unread' })
  })

  it('answers unread for a manifest that does not parse', async () => {
    const fetch = stubFetch({ [MANIFEST_URL]: { body: utf8('{"orivonApiVersion":1}') } })
    expect(await fetchManifestAtRoot(fetch, PUBLIC_RESOLVER, ORIGIN, CID)).toMatchObject({ kind: 'unread' })
  })

  it('answers unread when the request itself fails', async () => {
    const fetch: Fetch = async () => { throw new Error('connection refused') }
    expect(await fetchManifestAtRoot(fetch, PUBLIC_RESOLVER, ORIGIN, CID)).toMatchObject({ kind: 'unread' })
  })

  it('answers unread, with no request, for an origin the install guard refuses', async () => {
    const seen: string[] = []
    const fetch: Fetch = async (url) => { seen.push(url); throw new Error('unreachable') }
    expect(await fetchManifestAtRoot(fetch, async () => ['10.0.0.1'], ORIGIN, CID)).toMatchObject({ kind: 'unread' })
    expect(seen).toEqual([])
  })
})
