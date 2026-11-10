import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { partitionFor } from '../../../broker/grants/origin-hash.js'
import { oldPartitionDirectory, storageKindsOnDisk, storageNotCarried } from '../old-data.js'

const ORIGIN = 'https://wiki.eth'
let userData = ''
let folder = ''
beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'carry-old-'))
  folder = oldPartitionDirectory(userData, ORIGIN)
  mkdirSync(folder, { recursive: true })
})
afterEach(() => { rmSync(userData, { recursive: true, force: true }) })

function write (relative: string, bytes: number): void {
  const path = join(folder, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 1))
}

describe('where the old partition is', () => {
  it('is the folder Electron keeps the app\'s persistent partition in', () => {
    expect(oldPartitionDirectory('/data', ORIGIN)).toBe(join('/data', 'Partitions', partitionFor(ORIGIN).replace('persist:', '')))
  })
})

describe('what the folder shows was stored', () => {
  it('shows nothing for a partition a session made and nothing used', () => {
    mkdirSync(join(folder, 'Local Storage', 'leveldb'), { recursive: true })
    write('Local Storage/leveldb/LOG', 0)
    write('Local Storage/leveldb/000003.log', 30)
    write('Local Storage/leveldb/MANIFEST-000001', 41)
    mkdirSync(join(folder, 'Session Storage'), { recursive: true })
    expect(storageKindsOnDisk(folder)).toEqual([])
  })

  it('shows nothing for a folder that is not there', () => {
    expect(storageKindsOnDisk(join(userData, 'nowhere'))).toEqual([])
  })

  it('shows cookies once the cookie file exists', () => {
    write('Cookies', 20480)
    expect(storageKindsOnDisk(folder)).toEqual(['cookies'])
  })

  it('shows local storage once a log is longer than its header, or a table file exists', () => {
    write('Local Storage/leveldb/000003.log', 31)
    expect(storageKindsOnDisk(folder)).toEqual(['local storage'])
    rmSync(join(folder, 'Local Storage'), { recursive: true })
    write('Local Storage/leveldb/000005.ldb', 100)
    expect(storageKindsOnDisk(folder)).toEqual(['local storage'])
  })

  it('shows databases once the database folder holds one', () => {
    mkdirSync(join(folder, 'IndexedDB'))
    expect(storageKindsOnDisk(folder)).toEqual([])
    mkdirSync(join(folder, 'IndexedDB', 'https_wiki.eth_0.indexeddb.leveldb'))
    expect(storageKindsOnDisk(folder)).toEqual(['databases'])
  })

  it('lists every kind it finds', () => {
    write('Cookies', 20480)
    write('Local Storage/leveldb/000003.log', 400)
    mkdirSync(join(folder, 'IndexedDB', 'https_wiki.eth_0.indexeddb.leveldb'), { recursive: true })
    expect(storageKindsOnDisk(folder)).toEqual(['cookies', 'local storage', 'databases'])
  })
})

describe('what the carry leaves behind', () => {
  it('names the workers, the Cache Storage and the private file system when the partition holds them', () => {
    expect(storageNotCarried(folder)).toEqual([])
    write('Service Worker/Database/000003.log', 40)
    write('File System/Origins/000001', 40)
    expect(storageNotCarried(folder)).toEqual(['service workers and Cache Storage', 'files in the private file system'])
  })
})
