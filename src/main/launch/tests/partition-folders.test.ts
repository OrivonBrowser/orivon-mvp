import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { HASHED_PARTITION_KINDS, hashedPartitionName, originHash } from '../../../broker/grants/origin-hash.js'
import { moveLongNamedPartitionFolders, shortFolderName } from '../partition-folders.js'
import type { FolderIo } from '../partition-folders.js'

const longName = (kind: string, origin: string): string => `${kind}-${originHash(origin)}`
const shortName = (kind: string, origin: string): string => `${kind}-${originHash(origin).slice(0, 32)}`
const APP = 'https://app.example'
const OTHER = 'https://other.example'

describe('shortFolderName', () => {
  it('keeps the first 32 digits of every kind of session folder', () => {
    for (const kind of HASHED_PARTITION_KINDS) expect(shortFolderName(longName(kind, APP))).toBe(shortName(kind, APP))
  })

  it('is the folder Electron makes for the name `hashedPartitionName` builds, for every kind', () => {
    for (const kind of HASHED_PARTITION_KINDS) {
      const folder = hashedPartitionName(kind, APP).slice('persist:'.length)
      expect(shortFolderName(longName(kind, APP))).toBe(folder)
    }
  })

  it('names nothing else: short names, other kinds, other lengths, capitals and suffixes are left alone', () => {
    const hash = originHash(APP)
    expect(shortFolderName(shortName('app', APP))).toBeUndefined()
    expect(shortFolderName(`site-${hash}`)).toBeUndefined()
    expect(shortFolderName('tunnel-profile')).toBeUndefined()
    expect(shortFolderName('orivon-shell')).toBeUndefined()
    expect(shortFolderName(`app-${hash.slice(0, 63)}`)).toBeUndefined()
    expect(shortFolderName(`app-${hash}0`)).toBeUndefined()
    expect(shortFolderName(`app-${hash.toUpperCase()}`)).toBeUndefined()
    expect(shortFolderName(`app-${hash}.old`)).toBeUndefined()
    expect(shortFolderName(`xapp-${hash}`)).toBeUndefined()
  })
})

describe('moving the folders of the long names', () => {
  let userData: string
  let partitions: string
  let log: MockInstance<typeof console.log>
  let warn: MockInstance<typeof console.warn>

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orivon-partition-folders-'))
    partitions = join(userData, 'Partitions')
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true })
  })

  /** A session folder with a file and a nested one in it, as a session leaves. */
  function seed (name: string, content: string): string {
    const folder = join(partitions, name)
    mkdirSync(join(folder, 'Local Storage', 'leveldb'), { recursive: true })
    writeFileSync(join(folder, 'Cookies'), content)
    writeFileSync(join(folder, 'Local Storage', 'leveldb', '000003.log'), content)
    return folder
  }

  /** The real file system, with the calls named made to throw an error that carries `code` while `refusals` last. */
  function refusing (calls: ReadonlyArray<'rename' | 'removeEmpty' | 'list'>, code: string, refusals = Number.POSITIVE_INFINITY): { io: FolderIo, waits: number[], renames: string[] } {
    let left = refusals
    const waits: number[] = []
    const renames: string[] = []
    const fail = (call: 'rename' | 'removeEmpty' | 'list'): void => {
      if (calls.includes(call) && left > 0) {
        left -= 1
        throw Object.assign(new Error(`${code} from ${call}`), { code })
      }
    }
    const io: FolderIo = {
      list: (dir) => { fail('list'); return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })) },
      rename: (from, to) => { fail('rename'); renames.push(to); renameSync(from, to) },
      removeEmpty: (dir) => { fail('removeEmpty'); rmdirSync(dir) },
      wait: (ms) => { waits.push(ms) }
    }
    return { io, waits, renames }
  }

  it('renames the folder with everything in it, so the session that opens the short name finds its data', () => {
    const from = seed(longName('app', APP), 'kept')
    const moves = moveLongNamedPartitionFolders(userData)
    const to = join(partitions, shortName('app', APP))
    expect(moves).toEqual([{ from, to, outcome: 'moved' }])
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(to, 'Cookies'), 'utf8')).toBe('kept')
    expect(readFileSync(join(to, 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe('kept')
  })

  it('moves every kind and every origin, and leaves every other folder and file where it is', () => {
    seed(longName('app', APP), 'a')
    seed(longName('app', OTHER), 'b')
    seed(longName('embed', APP), 'c')
    seed(longName('local', 'file:///home/u/notes.html'), 'd')
    for (const kept of ['tunnel-profile', 'orivon-shell', `site-${originHash(APP)}`, shortName('app', 'https://third.example')]) seed(kept, 'untouched')
    writeFileSync(join(partitions, longName('app', 'https://file.example')), 'a file, not a folder')
    const moves = moveLongNamedPartitionFolders(userData)
    expect(moves.map((move) => move.outcome)).toEqual(['moved', 'moved', 'moved', 'moved'])
    expect(readdirSync(partitions).sort()).toEqual([
      longName('app', 'https://file.example'),
      `site-${originHash(APP)}`,
      shortName('app', APP),
      shortName('app', OTHER),
      shortName('app', 'https://third.example'),
      shortName('embed', APP),
      shortName('local', 'file:///home/u/notes.html'),
      'orivon-shell',
      'tunnel-profile'
    ].sort())
    expect(readFileSync(join(partitions, 'tunnel-profile', 'Cookies'), 'utf8')).toBe('untouched')
  })

  it('has nothing to do, and says nothing, with no Partitions folder or no long name in it', () => {
    expect(moveLongNamedPartitionFolders(userData)).toEqual([])
    seed(shortName('app', APP), 'already short')
    expect(moveLongNamedPartitionFolders(userData)).toEqual([])
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('moves nothing over a short name that already holds data, leaves both folders as they are and says so', () => {
    const from = seed(longName('app', APP), 'from the long name')
    const to = seed(shortName('app', APP), 'from the short name')
    const moves = moveLongNamedPartitionFolders(userData)
    expect(moves).toEqual([{ from, to, outcome: 'conflict', code: 'ENOTEMPTY' }])
    expect(readFileSync(join(from, 'Cookies'), 'utf8')).toBe('from the long name')
    expect(readFileSync(join(to, 'Cookies'), 'utf8')).toBe('from the short name')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('already holds data')
  })

  it('does the same on every start while the conflict lasts, and moves the folder once the short name is gone', () => {
    const from = seed(longName('app', APP), 'long')
    const to = seed(shortName('app', APP), 'short')
    expect(moveLongNamedPartitionFolders(userData)[0]?.outcome).toBe('conflict')
    expect(moveLongNamedPartitionFolders(userData)[0]?.outcome).toBe('conflict')
    rmSync(to, { recursive: true })
    expect(moveLongNamedPartitionFolders(userData)[0]?.outcome).toBe('moved')
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(to, 'Cookies'), 'utf8')).toBe('long')
  })

  it('replaces an empty folder of the short name, which holds no data', () => {
    const from = seed(longName('app', APP), 'kept')
    const to = join(partitions, shortName('app', APP))
    mkdirSync(to)
    expect(moveLongNamedPartitionFolders(userData)).toEqual([{ from, to, outcome: 'moved' }])
    expect(readFileSync(join(to, 'Cookies'), 'utf8')).toBe('kept')
  })

  it('never asks to rename over a short name that holds data, when the system says it is not empty', () => {
    seed(longName('app', APP), 'long')
    seed(shortName('app', APP), 'short')
    const { io, renames } = refusing([], 'EIO')
    moveLongNamedPartitionFolders(userData, io)
    expect(renames).toEqual([])
  })

  it('tries a folder a process holds again after a pause, and moves it once the process lets go', () => {
    const from = seed(longName('app', APP), 'kept')
    const { io, waits } = refusing(['rename'], 'EBUSY', 2)
    const moves = moveLongNamedPartitionFolders(userData, io)
    expect(moves.map((move) => move.outcome)).toEqual(['moved'])
    expect(waits).toEqual([100, 250])
    expect(existsSync(from)).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(['EBUSY', 'EPERM', 'EACCES'])('leaves a folder that %s keeps refusing where it is, tries five times more, and says so', (code) => {
    const from = seed(longName('app', APP), 'kept')
    const { io, waits } = refusing(['rename'], code)
    const moves = moveLongNamedPartitionFolders(userData, io)
    expect(moves).toEqual([{ from, to: join(partitions, shortName('app', APP)), outcome: 'failed', code }])
    expect(waits).toEqual([100, 250, 650, 1000, 2000])
    expect(readFileSync(join(from, 'Cookies'), 'utf8')).toBe('kept')
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toContain(code)
    expect(line).toContain('tried again at the next start')
  })

  it('does not pause for a refusal that waiting cannot lift', () => {
    seed(longName('app', APP), 'kept')
    const { io, waits } = refusing(['rename'], 'EIO')
    expect(moveLongNamedPartitionFolders(userData, io)[0]).toMatchObject({ outcome: 'failed', code: 'EIO' })
    expect(waits).toEqual([])
  })

  it('pauses once for every folder a process holds, not once for each', () => {
    seed(longName('app', APP), 'a')
    seed(longName('app', OTHER), 'b')
    const { io, waits } = refusing(['rename'], 'EBUSY', 2)
    expect(moveLongNamedPartitionFolders(userData, io).map((move) => move.outcome)).toEqual(['moved', 'moved'])
    expect(waits).toEqual([100])
  })

  it('finishes a partial move at the next start: the folders already moved stay, the refused ones follow', () => {
    seed(longName('app', APP), 'first')
    seed(longName('app', OTHER), 'second')
    seed(longName('embed', APP), 'third')
    const stuck = { code: 'EPERM', folder: longName('app', OTHER) }
    const io: FolderIo = {
      ...refusing([], 'EIO').io,
      rename: (from, to) => {
        if (from.endsWith(stuck.folder)) throw Object.assign(new Error('refused'), { code: stuck.code })
        renameSync(from, to)
      }
    }
    const first = moveLongNamedPartitionFolders(userData, io)
    expect(first.filter((move) => move.outcome === 'moved')).toHaveLength(2)
    expect(first.filter((move) => move.outcome === 'failed')).toHaveLength(1)
    expect(existsSync(join(partitions, stuck.folder))).toBe(true)

    const second = moveLongNamedPartitionFolders(userData)
    expect(second.map((move) => move.outcome)).toEqual(['moved'])
    expect(readdirSync(partitions).sort()).toEqual([shortName('app', APP), shortName('app', OTHER), shortName('embed', APP)].sort())
    expect(readFileSync(join(partitions, shortName('app', OTHER), 'Cookies'), 'utf8')).toBe('second')
    expect(moveLongNamedPartitionFolders(userData)).toEqual([])
  })

  it('leaves the old data where it is, and meets a conflict at every start after it, when a refused folder is followed by a session that fills the short name', () => {
    const from = seed(longName('app', APP), 'older data')
    const { io } = refusing(['rename'], 'EBUSY')
    expect(moveLongNamedPartitionFolders(userData, io)[0]?.outcome).toBe('failed')
    // The run goes on without the move: the app's session opens the short name and writes into it.
    const to = seed(shortName('app', APP), 'a new session')
    for (let start = 0; start < 3; start += 1) expect(moveLongNamedPartitionFolders(userData)[0]).toMatchObject({ from, to, outcome: 'conflict' })
    expect(readFileSync(join(from, 'Cookies'), 'utf8')).toBe('older data')
    expect(readFileSync(join(to, 'Cookies'), 'utf8')).toBe('a new session')
  })

  it('moves a folder over the empty one it removed when the rename is refused once and then goes through', () => {
    const from = seed(longName('app', APP), 'kept')
    mkdirSync(join(partitions, shortName('app', APP)))
    const { io, waits } = refusing(['rename'], 'EBUSY', 1)
    expect(moveLongNamedPartitionFolders(userData, io).map((move) => move.outcome)).toEqual(['moved'])
    expect(waits).toEqual([100])
    expect(existsSync(from)).toBe(false)
  })

  it('reports a conflict when the system says the short name is not empty at the rename itself', () => {
    const from = seed(longName('app', APP), 'kept')
    const { io } = refusing(['rename'], 'ENOTEMPTY')
    expect(moveLongNamedPartitionFolders(userData, io)[0]).toMatchObject({ outcome: 'conflict', code: 'ENOTEMPTY' })
    expect(existsSync(from)).toBe(true)
  })

  it('fails, without a pause or a rename, when the short name is not a folder it can remove', () => {
    const from = seed(longName('app', APP), 'kept')
    writeFileSync(join(partitions, shortName('app', APP)), 'a file in the way')
    const { io, waits, renames } = refusing([], 'EIO')
    expect(moveLongNamedPartitionFolders(userData, io)[0]).toMatchObject({ outcome: 'failed', code: 'ENOTDIR' })
    expect(waits).toEqual([])
    expect(renames).toEqual([])
    expect(readFileSync(join(partitions, shortName('app', APP)), 'utf8')).toBe('a file in the way')
    expect(existsSync(from)).toBe(true)
  })

  it('reports a folder that was no longer there when its turn came, without calling it a failure', () => {
    seed(longName('app', APP), 'kept')
    const { io } = refusing(['rename'], 'ENOENT')
    expect(moveLongNamedPartitionFolders(userData, io)[0]?.outcome).toBe('gone')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('leaves the folder when the empty one in the way cannot be removed, and tries again after a pause when a process holds it', () => {
    const from = seed(longName('app', APP), 'kept')
    mkdirSync(join(partitions, shortName('app', APP)))
    const { io, waits } = refusing(['removeEmpty'], 'EBUSY', 1)
    expect(moveLongNamedPartitionFolders(userData, io).map((move) => move.outcome)).toEqual(['moved'])
    expect(waits).toEqual([100])
    expect(existsSync(from)).toBe(false)
  })

  it('moves nothing, and does not throw, when the Partitions folder cannot be read', () => {
    seed(longName('app', APP), 'kept')
    const { io } = refusing(['list'], 'EACCES')
    expect(moveLongNamedPartitionFolders(userData, io)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(existsSync(join(partitions, longName('app', APP)))).toBe(true)
  })

  it('logs every outcome in a line a report can show, naming the folder by the start of its name', () => {
    seed(longName('app', APP), 'a')
    seed(longName('embed', OTHER), 'b')
    seed(shortName('embed', OTHER), 'held')
    moveLongNamedPartitionFolders(userData)
    const lines = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0]))
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.startsWith('[partitions] '))).toBe(true)
    expect(lines.join('\n')).toContain(`app-${originHash(APP).slice(0, 8)}`)
    expect(lines.join('\n')).not.toContain(originHash(APP))
  })
})
