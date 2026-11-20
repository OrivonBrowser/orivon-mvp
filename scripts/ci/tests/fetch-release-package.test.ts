import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestOf, downloadVerified, fetchReleasePackage, pickAsset } from '../fetch-release-package.mjs'

const assets = [
  { name: 'ipfs.json' },
  { name: 'Orivon-0.1.0-arm64.dmg' },
  { name: 'Orivon-0.1.0-x64.dmg' },
  { name: 'Orivon-0.1.0-x86_64.AppImage' },
  { name: 'Orivon-Setup-0.1.0-x64.exe' },
  { name: 'orivon_0.1.0_amd64.deb' }
]

describe('pickAsset', () => {
  it('takes the deb for Linux, the installer for Windows and the dmg of the Mac\'s architecture', () => {
    expect(pickAsset('linux', 'x64', assets)?.name).toBe('orivon_0.1.0_amd64.deb')
    expect(pickAsset('win', 'x64', assets)?.name).toBe('Orivon-Setup-0.1.0-x64.exe')
    expect(pickAsset('mac', 'arm64', assets)?.name).toBe('Orivon-0.1.0-arm64.dmg')
    expect(pickAsset('mac', 'x64', assets)?.name).toBe('Orivon-0.1.0-x64.dmg')
  })

  it('is undefined when the release has no such package, and refuses a system it has no package name for', () => {
    expect(pickAsset('linux', 'x64', [{ name: 'Orivon-0.1.0-x86_64.AppImage' }])).toBeUndefined()
    expect(() => pickAsset('mac', 'ia32', assets)).toThrow('no package of mac for ia32')
    expect(() => pickAsset('plan9', 'x64', assets)).toThrow('no package of plan9')
  })
})

describe('digestOf', () => {
  const hex = 'a'.repeat(64)

  it('reads the hex out of the digest GitHub reports', () => {
    expect(digestOf({ name: 'x', digest: `sha256:${hex}` })).toBe(hex)
  })

  it('refuses an asset with no digest, another algorithm or a malformed one', () => {
    for (const digest of [undefined, '', 'sha1:abc', `sha256:${hex.slice(1)}`, `sha256:${hex.toUpperCase()}`]) {
      expect(() => digestOf({ name: 'x', digest })).toThrow('GitHub reports no SHA-256 for x')
    }
  })
})

describe('downloading a package', () => {
  const folders: string[] = []
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
  const folder = (): string => { const made = mkdtempSync(join(tmpdir(), 'fetch-release-')); folders.push(made); return made }
  const bytes = Buffer.from('a package')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const serving = (body: Buffer, status = 200) => async () => new Response(status === 200 ? new Uint8Array(body) : null, { status })

  it('keeps a file whose SHA-256 is the one reported', async () => {
    const file = join(folder(), 'orivon.deb')
    await downloadVerified('https://example.invalid/orivon.deb', file, digest, serving(bytes) as typeof fetch)
    expect(readFileSync(file)).toEqual(bytes)
  })

  it('deletes a file that does not match and says so', async () => {
    const file = join(folder(), 'orivon.deb')
    await expect(downloadVerified('https://example.invalid/orivon.deb', file, digest, serving(Buffer.from('another')) as typeof fetch)).rejects.toThrow('does not match the SHA-256')
    expect(existsSync(file)).toBe(false)
  })

  it('names the answer of a server that refuses', async () => {
    await expect(downloadVerified('https://example.invalid/x', join(folder(), 'x'), digest, serving(bytes, 404) as typeof fetch)).rejects.toThrow('answered 404')
  })
})

describe('fetchReleasePackage', () => {
  const folders: string[] = []
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
  const bytes = Buffer.from('the v0.1.0 deb')
  const release = { draft: false, assets: [{ name: 'orivon_0.1.0_amd64.deb', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, browser_download_url: 'https://example.invalid/download/orivon_0.1.0_amd64.deb' }] }
  const github = (answer: object | undefined) => async (url: string | URL | Request) =>
    String(url).startsWith('https://api.github.com/repos/OrivonBrowser/orivon-mvp/releases/tags/v0.1.0')
      ? (answer === undefined ? new Response('{}', { status: 404 }) : Response.json(answer))
      : new Response(new Uint8Array(bytes))

  it('looks the tag up, downloads the system\'s package into the folder and returns its path', async () => {
    const into = mkdtempSync(join(tmpdir(), 'fetch-release-'))
    folders.push(into)
    const path = await fetchReleasePackage({ tag: 'v0.1.0', platform: 'linux', folder: join(into, 'nested'), architecture: 'x64', fetchImpl: github(release) as typeof fetch })
    expect(path).toBe(join(into, 'nested', 'orivon_0.1.0_amd64.deb'))
    expect(readFileSync(path)).toEqual(bytes)
  })

  it('refuses an unknown tag, a draft, a release with no package for the system and a tag that is not one', async () => {
    const options = { platform: 'linux', folder: join(tmpdir(), 'fetch-release-never'), architecture: 'x64' }
    await expect(fetchReleasePackage({ ...options, tag: 'v0.1.0', fetchImpl: github(undefined) as typeof fetch })).rejects.toThrow('no readable release v0.1.0')
    await expect(fetchReleasePackage({ ...options, tag: 'v0.1.0', fetchImpl: github({ ...release, draft: true }) as typeof fetch })).rejects.toThrow('is a draft')
    await expect(fetchReleasePackage({ ...options, tag: 'v0.1.0', platform: 'win', fetchImpl: github(release) as typeof fetch })).rejects.toThrow('has no win package')
    await expect(fetchReleasePackage({ ...options, tag: '../x?y', fetchImpl: github(release) as typeof fetch })).rejects.toThrow('is not a release tag')
  })
})
