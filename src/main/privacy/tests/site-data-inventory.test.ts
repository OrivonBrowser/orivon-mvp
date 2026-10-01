import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { folderBytes, inventory, originOfFolder, originsToClear } from '../site-data-inventory.js'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orivon-inventory-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function indexedDb (name: string, bytes: number): void {
  const dir = join(root, 'IndexedDB', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '000003.log'), Buffer.alloc(bytes))
}

describe('the origin an IndexedDB folder names', () => {
  it('reads scheme, host and port, and drops a default port', () => {
    expect(originOfFolder('http_127.0.0.1_8080.indexeddb.leveldb')).toBe('http://127.0.0.1:8080')
    expect(originOfFolder('https_shop.example_443.indexeddb.leveldb')).toBe('https://shop.example')
    expect(originOfFolder('https_my_host.example_8443.indexeddb.blob')).toBe('https://my_host.example:8443')
    expect(originOfFolder('http_[::1]_80.indexeddb.leveldb')).toBe('http://[::1]')
  })

  it('refuses what is not an IndexedDB folder or not a web origin', () => {
    expect(originOfFolder('chrome-extension_abc_0.indexeddb.leveldb')).toBeNull()
    expect(originOfFolder('Cache')).toBeNull()
    expect(originOfFolder('http_a b_80.indexeddb.leveldb')).toBeNull()
  })
})

describe('the sites a session keeps data for', () => {
  const cookie = (name: string, domain: string): { name: string, domain: string } => ({ name, domain })

  it('groups cookies by registrable domain and folds the hosts in', async () => {
    const sites = await inventory([cookie('a', '.shop.example'), cookie('b', 'www.shop.example'), cookie('c', 'cdn.shop.example'), cookie('d', 'other.example')], null)
    expect(sites).toEqual([
      { domain: 'other.example', hosts: ['other.example'], cookies: 1, kinds: [], bytes: null, origins: [] },
      { domain: 'shop.example', hosts: ['cdn.shop.example', 'shop.example', 'www.shop.example'], cookies: 3, kinds: [], bytes: null, origins: [] }
    ])
  })

  it('adds origins found on disk, with their size, and joins them to the site their cookies are in', async () => {
    indexedDb('https_www.shop.example_443.indexeddb.leveldb', 1000)
    indexedDb('https_www.shop.example_443.indexeddb.blob', 500)
    indexedDb('http_127.0.0.1_8080.indexeddb.leveldb', 20)
    const sites = await inventory([cookie('a', '.shop.example')], root)
    expect(sites.find((site) => site.domain === 'shop.example')).toMatchObject({ cookies: 1, kinds: ['IndexedDB'], bytes: 1500, origins: ['https://www.shop.example'], hosts: ['shop.example', 'www.shop.example'] })
    expect(sites.find((site) => site.domain === '127.0.0.1')).toMatchObject({ cookies: 0, kinds: ['IndexedDB'], bytes: 20, origins: ['http://127.0.0.1:8080'] })
  })

  it('reports no size when there is nothing on disk to measure, or none can be read', async () => {
    expect((await inventory([cookie('a', 'x.example')], join(root, 'missing')))[0]?.bytes).toBeNull()
  })

  it('stops measuring when its budget is spent, and says the size is unknown', async () => {
    indexedDb('https_a.example_443.indexeddb.leveldb', 10)
    let clock = 0
    const sites = await inventory([], root, 2000, () => { clock += 5000; return clock })
    expect(sites).toHaveLength(1)
    expect(sites[0]?.bytes).toBeNull()
  })

  it('counts a folder\'s files and its subfolders, and a missing folder as nothing', async () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'x'), Buffer.alloc(3))
    writeFileSync(join(root, 'a', 'b', 'y'), Buffer.alloc(4))
    expect(await folderBytes(join(root, 'a'), { expired: () => false })).toBe(7)
    expect(await folderBytes(join(root, 'nope'), { expired: () => false })).toBe(0)
    expect(await folderBytes(join(root, 'a'), { expired: () => true })).toBeNull()
  })
})

describe('what a clear of a site must name', () => {
  it('names both schemes of every host and every origin found with its port', () => {
    expect(originsToClear({ hosts: ['shop.example'], origins: ['https://shop.example:8443'] }).sort()).toEqual(['http://shop.example', 'https://shop.example', 'https://shop.example:8443'])
  })

  it('brackets an IPv6 host', () => {
    expect(originsToClear({ hosts: ['::1'], origins: [] })).toContain('http://[::1]')
  })
})
