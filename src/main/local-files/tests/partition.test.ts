import { afterEach, describe, expect, it } from 'vitest'
import { originHash } from '../../../broker/grants/origin-hash.js'
import { LocalFileApps, installLocalFileApps } from '../local-file-apps.js'
import { LOCAL_FILES_PARTITION, allLocalPartitions, isLocalPartition, localPartitionFor } from '../partition.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FILE = 'file:///home/u/notes/app.html'

afterEach(() => { installLocalFileApps(undefined) })

describe('localPartitionFor -- which session a local file runs in', () => {
  it('is the shared local-files session for a file with no record, persistent like a website\'s', () => {
    expect(LOCAL_FILES_PARTITION).toBe('persist:orivon-local-files')
    expect(localPartitionFor(FILE)).toBe(LOCAL_FILES_PARTITION)
  })

  it('is a session of its own, named by the key\'s hash, once the file is recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-partition-'))
    try {
      const apps = new LocalFileApps(join(dir, 'a.json'))
      apps.add(FILE)
      installLocalFileApps(apps)

      expect(localPartitionFor(FILE)).toBe(`persist:local-${originHash(FILE)}`)
      expect(localPartitionFor('file:///home/u/notes/other.html')).toBe(LOCAL_FILES_PARTITION)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the key from a full URL: query and fragment do not change the session', () => {
    expect(localPartitionFor(`${FILE}?q=1#top`)).toBe(localPartitionFor(FILE))
  })

  it('is undefined for anything that is not a local file', () => {
    for (const url of ['https://x.example/', 'file://host/a.html', 'about:blank']) expect(localPartitionFor(url)).toBeUndefined()
  })
})

describe('isLocalPartition', () => {
  it('recognises the shared session and a per-file one, and nothing else', () => {
    expect(isLocalPartition(LOCAL_FILES_PARTITION)).toBe(true)
    expect(isLocalPartition(`persist:local-${originHash(FILE)}`)).toBe(true)
    expect(isLocalPartition(`persist:app-${originHash('https://x.example')}`)).toBe(false)
    expect(isLocalPartition('persist:orivon-shell')).toBe(false)
    expect(isLocalPartition(undefined)).toBe(false)
  })
})

describe('allLocalPartitions', () => {
  it('is the shared session alone with no record, and adds one session per recorded file', () => {
    expect(allLocalPartitions()).toEqual([LOCAL_FILES_PARTITION])

    const dir = mkdtempSync(join(tmpdir(), 'orivon-partition-'))
    try {
      const apps = new LocalFileApps(join(dir, 'a.json'))
      apps.add(FILE)
      apps.add('file:///home/u/notes/other.html')
      installLocalFileApps(apps)

      expect(allLocalPartitions()).toEqual([
        LOCAL_FILES_PARTITION,
        `persist:local-${originHash(FILE)}`,
        `persist:local-${originHash('file:///home/u/notes/other.html')}`
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
