import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundledExtensions, DEFAULT_BOOKMARKS, defaultBookmarks, defaultProfileDir, defaultProfileOn } from '../default-profile.js'
import { sanitizeBrowserUrl } from '../../browsing/local-file-input.js'

const REAL_ICONS = join(import.meta.dirname, '../../../../resources/default-profile')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'default-profile-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('defaultProfileOn', () => {
  it('is on unless the switch says off', () => {
    expect(defaultProfileOn({})).toBe(true)
    expect(defaultProfileOn({ ORIVON_DEFAULT_PROFILE: 'on' })).toBe(true)
    expect(defaultProfileOn({ ORIVON_DEFAULT_PROFILE: 'off' })).toBe(false)
    expect(defaultProfileOn({ ORIVON_DEFAULT_PROFILE: 'anything else' })).toBe(true)
  })
})

describe('defaultProfileDir', () => {
  it('reads the resources folder of a package, and the repository folder from source', () => {
    expect(defaultProfileDir({ packaged: true, resourcesPath: '/opt/Orivon/resources', moduleDir: '/x/out/main' })).toBe(join('/opt/Orivon/resources', 'default-profile'))
    expect(defaultProfileDir({ packaged: false, resourcesPath: '/opt/Orivon/resources', moduleDir: join('/repo', 'out', 'main') })).toBe(join('/repo', 'resources', 'default-profile'))
  })
})

describe('the default bookmarks', () => {
  it('are the five the owner named, in order, each with an icon file', () => {
    expect(DEFAULT_BOOKMARKS.map((entry) => [entry.title, entry.url])).toEqual([
      ['Uniswap', 'https://app.uniswap.org'],
      ['James Carnley', 'ipfs://jamescarnley.eth/'],
      ['ENS Interviews', 'ipfs://ensinterviews.eth/'],
      ['Web3 Compass', 'https://web3compass.net'],
      ['Vitalik Buterin', 'ipfs://vitalik.eth']
    ])
  })

  it('are all addresses the bookmark store accepts, and the real icons load as data: URLs', async () => {
    for (const entry of DEFAULT_BOOKMARKS) expect(sanitizeBrowserUrl(entry.url), entry.url).not.toBeNull()
    const tree = await defaultBookmarks(REAL_ICONS)
    expect(tree).toHaveLength(5)
    for (const node of tree) expect(node.favicon).toMatch(/^data:image\/png;base64,/)
  })

  it('give a bookmark with no icon file a null icon rather than failing', async () => {
    await mkdir(join(dir, 'bookmark-icons'))
    await writeFile(join(dir, 'bookmark-icons', 'uniswap.png'), PNG)
    const tree = await defaultBookmarks(dir)
    expect(tree[0]).toMatchObject({ kind: 'url', title: 'Uniswap', url: 'https://app.uniswap.org', favicon: `data:image/png;base64,${PNG.toString('base64')}` })
    expect(tree.slice(1).every((node) => node.favicon === null)).toBe(true)
  })
})

describe('bundledExtensions', () => {
  const entry = { file: 'a.crx', name: 'A', version: '1', url: 'https://example.invalid/a.crx', sha256: 'f'.repeat(64), pinned: true }

  it('lists an entry whose file is present, and reports and skips one whose file is missing', async () => {
    await mkdir(join(dir, 'extensions'))
    await writeFile(join(dir, 'extensions', 'a.crx'), 'x')
    await writeFile(join(dir, 'bundled-extensions.json'), JSON.stringify([entry, { ...entry, file: 'b.crx', name: 'B' }]))
    const report = vi.fn()
    expect(await bundledExtensions(dir, report)).toEqual([{ name: 'A', path: join(dir, 'extensions', 'a.crx'), pinned: true }])
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]![0]).toContain('B')
  })

  it('gives nothing, and says so, for a list that is missing, not JSON or not an array', async () => {
    const report = vi.fn()
    expect(await bundledExtensions(dir, report)).toEqual([])
    await writeFile(join(dir, 'bundled-extensions.json'), '{not json')
    expect(await bundledExtensions(dir, report)).toEqual([])
    await writeFile(join(dir, 'bundled-extensions.json'), '{}')
    expect(await bundledExtensions(dir, report)).toEqual([])
    expect(report).toHaveBeenCalledTimes(3)
  })

  it('drops an entry whose file name could leave the extensions folder', async () => {
    await writeFile(join(dir, 'bundled-extensions.json'), JSON.stringify([{ ...entry, file: '../a.crx' }, { ...entry, file: 5 }]))
    const report = vi.fn()
    expect(await bundledExtensions(dir, report)).toEqual([])
    expect(report).toHaveBeenCalledTimes(2)
  })
})
