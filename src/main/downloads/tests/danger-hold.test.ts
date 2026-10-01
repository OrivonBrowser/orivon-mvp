import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { holdPath, isHoldPath, keepPath, released, restoreEntries, shouldHold } from '../danger-hold.js'
import type { DownloadEntry } from '../download-types.js'

const DIR = join('/', 'dl')
const entry = (over: Partial<DownloadEntry> = {}): DownloadEntry => ({
  id: 'a', url: 'https://a.example/x', referrer: '', fileName: 'setup.exe', savePath: join(DIR, 'Unconfirmed a.download'), mime: 'application/octet-stream',
  total: 10, received: 10, state: 'held', startedAt: 1, danger: true, held: true, ...over
})

describe('shouldHold', () => {
  it('holds a name that runs code, in any case, and a content type that does', () => {
    expect(shouldHold('setup.exe', 'application/octet-stream', false)).toBe(true)
    expect(shouldHold('PHOTO.JPG.EXE', 'image/jpeg', false)).toBe(true)
    expect(shouldHold('download.bin', 'application/x-msdownload', false)).toBe(true)
  })

  it('holds nothing else', () => {
    expect(shouldHold('report.pdf', 'application/pdf', false)).toBe(false)
    expect(shouldHold('archive.zip', 'application/zip', false)).toBe(false)
  })

  it('holds nothing when the person has just chosen the file in a save dialog', () => {
    expect(shouldHold('setup.exe', 'application/octet-stream', true)).toBe(false)
  })
})

describe('holdPath and keepPath', () => {
  it('writes a held file under a name that is not its own, inside the downloads folder', () => {
    expect(holdPath(DIR, 'abc')).toBe(join(DIR, 'Unconfirmed abc.download'))
  })

  it('keeps a file under its real name in the same folder, numbered when that is taken', () => {
    expect(keepPath(entry(), () => false)).toBe(join(DIR, 'setup.exe'))
    const taken = new Set([join(DIR, 'setup.exe'), join(DIR, 'setup (1).exe')])
    expect(keepPath(entry(), (path) => taken.has(path))).toBe(join(DIR, 'setup (2).exe'))
  })
})

describe('isHoldPath', () => {
  it('accepts what holdPath makes and nothing else', () => {
    expect(isHoldPath(holdPath(DIR, '0123456789abcdef'))).toBe(true)
    expect(isHoldPath(holdPath(DIR, 'id1'))).toBe(true)
    for (const path of ['/etc/passwd', join(DIR, 'setup.exe'), join(DIR, 'Unconfirmed .download'), join(DIR, 'Unconfirmed a b.download'), join(DIR, 'Unconfirmed a.download.exe'), join('rel', 'Unconfirmed a.download'), '']) {
      expect(isHoldPath(path)).toBe(false)
    }
  })
})

describe('released', () => {
  it('is the same entry without the hold', () => {
    expect(released(entry())).not.toHaveProperty('held')
    expect(released(entry()).fileName).toBe('setup.exe')
  })
})

describe('restoreEntries', () => {
  const exists = (...paths: string[]) => (path: string): boolean => paths.includes(path)

  it('keeps a held entry whose temporary file is still there, and drops one whose file is gone', () => {
    const kept = entry({ id: 'k', savePath: join(DIR, 'Unconfirmed k.download') })
    const lost = entry({ id: 'l', savePath: join(DIR, 'Unconfirmed l.download') })
    const restored = restoreEntries([kept, lost], 5, exists(kept.savePath))
    expect(restored.entries.map((each) => each.id)).toEqual(['k'])
    expect(restored.entries[0]?.state).toBe('held')
    expect(restored.changed).toBe(true)
  })

  it('interrupts what was running, and names a held download\'s leftover file for deletion', () => {
    const running = entry({ id: 'r', state: 'progressing' })
    const plain = entry({ id: 'p', state: 'progressing', held: false })
    const { held: _held, ...plainWithoutHold } = plain
    const restored = restoreEntries([running, plainWithoutHold as DownloadEntry], 5, exists())
    expect(restored.entries.map((each) => [each.state, each.reason, each.endedAt])).toEqual([['interrupted', 'closed', 5], ['interrupted', 'closed', 5]])
    expect(restored.entries[0]).not.toHaveProperty('held')
    expect(restored.leftovers).toEqual([running.savePath])
  })

  it('reports no change for a list that is already settled', () => {
    const settled = entry({ state: 'completed', held: false })
    const restored = restoreEntries([settled], 5, exists())
    expect(restored.changed).toBe(false)
    expect(restored.entries).toEqual([settled])
  })
})
