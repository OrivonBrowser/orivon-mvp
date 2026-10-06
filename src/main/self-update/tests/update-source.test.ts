import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../download-update.js'
import { MANIFEST_ASSET, SIGNATURE_ASSET } from '../release-pick.js'
import { createReleaseSource, GITHUB_ENDPOINTS, readCapped } from '../update-source.js'
import type { UpdateEndpoints } from '../update-source.js'
import { MAX_MANIFEST_BYTES } from '../update-manifest.js'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const manifestText = (version = '1.2.0'): string => `${JSON.stringify({ format: 'orivon-update/1', version, files: [{ name: 'a.deb', size: 5, sha256: 'b'.repeat(64) }] }, null, 2)}\n`
const signatureOf = (text: string): string => sign(null, Buffer.from(text), privateKey).toString('base64')
const SIGNED = [{ name: MANIFEST_ASSET }, { name: SIGNATURE_ASSET }]
const list = [{ tag_name: 'v1.2.0', name: 'v1.2.0', draft: false, prerelease: false, assets: SIGNED }]

const ENDPOINTS: UpdateEndpoints = { list: 'https://list.test/releases', asset: (tag, name) => `https://assets.test/${tag}/${name}` }

function serving (routes: Record<string, () => Response>): { fetch: FetchLike, urls: string[] } {
  const urls: string[] = []
  const fetch: FetchLike = async (url) => {
    urls.push(url)
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected request to ${url}`)
    return route()
  }
  return { fetch, urls }
}
const source = (routes: Record<string, () => Response>, log: (message: string) => void = () => {}): { latest: () => ReturnType<ReturnType<typeof createReleaseSource>>, urls: string[] } => {
  const { fetch, urls } = serving(routes)
  return { latest: createReleaseSource({ fetch, endpoints: ENDPOINTS, trustedKeys: [PEM], log }), urls }
}
const goodRoutes = (text = manifestText(), signature = signatureOf(text)): Record<string, () => Response> => ({
  'https://list.test/releases': () => Response.json(list),
  'https://assets.test/v1.2.0/orivon-update.json': () => new Response(text),
  'https://assets.test/v1.2.0/orivon-update.json.sig': () => new Response(signature)
})

describe('the release source', () => {
  it('answers the signed release with its verified manifest and the page of the release', async () => {
    const { latest } = source(goodRoutes())
    const release = await latest()
    expect(release?.version).toBe('v1.2.0')
    expect(release?.url).toBe('https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v1.2.0')
    expect(release?.manifest?.files).toEqual([{ name: 'a.deb', size: 5, sha256: 'b'.repeat(64) }])
  })

  it('asks only for addresses it built itself, never one from the answer', async () => {
    const hostile = [{ ...list[0], html_url: 'https://evil.test/', url: 'https://evil.test/api', assets: [{ name: MANIFEST_ASSET, browser_download_url: 'https://evil.test/m' }, { name: SIGNATURE_ASSET, browser_download_url: 'https://evil.test/s' }] }]
    const { latest, urls } = source({ ...goodRoutes(), 'https://list.test/releases': () => Response.json(hostile) })
    await latest()
    expect(urls.every((url) => url.startsWith('https://list.test/') || url.startsWith('https://assets.test/'))).toBe(true)
  })

  it('offers nothing, and says why in the log, when the signature is wrong', async () => {
    const log = vi.fn()
    const { latest } = source(goodRoutes(manifestText(), signatureOf('something else')), log)
    expect(await latest()).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('v1.2.0'))
  })

  it('offers nothing when the manifest is for another version than its tag', async () => {
    const { latest } = source(goodRoutes(manifestText('1.2.1')))
    expect(await latest()).toBeNull()
  })

  it('answers null for a repository with no releases, and for no signed release', async () => {
    expect(await source({ 'https://list.test/releases': () => new Response('{}', { status: 404 }) }).latest()).toBeNull()
    expect(await source({ 'https://list.test/releases': () => Response.json([{ ...list[0], assets: [] }]) }).latest()).toBeNull()
    expect(await source({ 'https://list.test/releases': () => new Response('not json') }).latest()).toBeNull()
  })

  it('rejects when the source cannot be reached or refuses, which does not count as a check', async () => {
    await expect(source({ 'https://list.test/releases': () => new Response('', { status: 403 }) }).latest()).rejects.toThrow(/403/)
    await expect(source({ ...goodRoutes(), 'https://assets.test/v1.2.0/orivon-update.json': () => new Response('', { status: 404 }) }).latest()).rejects.toThrow(/manifest/)
  })

  it('refuses a manifest larger than the cap without trusting its declared length', async () => {
    const big = 'x'.repeat(MAX_MANIFEST_BYTES + 10)
    await expect(source({ ...goodRoutes(), 'https://assets.test/v1.2.0/orivon-update.json': () => new Response(big) }).latest()).rejects.toThrow(/larger/)
  })

  it('points at GitHub with the repository\'s constants, the tag percent-encoded', () => {
    expect(GITHUB_ENDPOINTS.list).toBe('https://api.github.com/repos/OrivonBrowser/orivon-mvp/releases?per_page=20')
    expect(GITHUB_ENDPOINTS.asset('v1.2.0', 'orivon-update.json')).toBe('https://github.com/OrivonBrowser/orivon-mvp/releases/download/v1.2.0/orivon-update.json')
    expect(GITHUB_ENDPOINTS.asset('v1.2.0', 'a b')).toContain('a%20b')
  })
})

describe('readCapped', () => {
  it('refuses a declared length over the cap before reading', async () => {
    await expect(readCapped(new Response('x', { headers: { 'content-length': '999' } }), 10)).rejects.toThrow(/larger/)
  })
})
