import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listDumps, pruneDumps } from '../dump-files.js'
import { DUMP_MATCH_MS, DUMP_MAX_AGE_MS, DUMP_MAX_BYTES, dumpFits, dumpFor, dumpsToDelete, DUMPS_KEPT, uncleanExitDump } from '../dumps.js'
import { stamp } from '../crash-records.js'
import type { CrashRecord } from '../crash-records.js'
import type { DumpFile } from '../dumps.js'

const NOW = 1_800_000_000_000
const dump = (name: string, ageMs: number, bytes = 100): DumpFile => ({ path: name, mtimeMs: NOW - ageMs, bytes })

describe('dumpFor', () => {
  it('matches a dump written within 60 seconds of the crash, and no other', () => {
    const near = dump('near', 30_000)
    expect(dumpFor(NOW, [dump('far', DUMP_MATCH_MS + 1), near])).toBe(near)
    expect(dumpFor(NOW, [dump('far', DUMP_MATCH_MS + 1)])).toBeUndefined()
    expect(dumpFor(NOW, [dump('edge', DUMP_MATCH_MS)])?.path).toBe('edge')
  })

  it('takes the closest when several fit, a later one included', () => {
    expect(dumpFor(NOW, [dump('a', 50_000), dump('b', -5_000), dump('c', 20_000)])?.path).toBe('b')
  })
})

describe('dumpFor with a lower bound', () => {
  it('never takes a dump written before the bound, even one within the minute', () => {
    expect(dumpFor(NOW, [dump('earlier', 30_000)], NOW)).toBeUndefined()
    expect(dumpFor(NOW, [dump('earlier', 30_000), dump('later', -30_000)], NOW)?.path).toBe('later')
    expect(dumpFor(NOW, [dump('at', 0)], NOW)?.path).toBe('at')
  })
})

describe('uncleanExitDump', () => {
  const marker = { sessionId: 's1', pid: 1, startedAt: NOW - 3_600_000 }
  const fatal = (atMs: number): CrashRecord => ({ id: 'a'.repeat(16), sessionId: 's1', kind: 'renderer', at: stamp(atMs), process: 'tab', reason: 'crashed', exitCode: 1, message: '', stack: '' })

  it('is the newest dump written during that run', () => {
    expect(uncleanExitDump(marker, [], [dump('a', 3_000_000), dump('b', 2_000_000), dump('old', 4_000_000)])).toBe(NOW - 2_000_000)
  })

  it('leaves out a dump within a minute of another record of that run: it belongs to that record', () => {
    const owned = dump('owned', 1_000_000)
    expect(uncleanExitDump(marker, [fatal(NOW - 1_000_000 + 20_000)], [owned])).toBeUndefined()
    expect(uncleanExitDump(marker, [fatal(NOW - 1_000_000 + 20_000)], [owned, dump('free', 2_000_000)])).toBe(NOW - 2_000_000)
  })

  it('is not held back by records of other runs, or by its own kind of record', () => {
    expect(uncleanExitDump(marker, [{ ...fatal(NOW - 1_000_000), sessionId: 's0' }, { ...fatal(NOW - 1_000_000), kind: 'unclean-exit' }], [dump('x', 1_000_000)])).toBe(NOW - 1_000_000)
  })
})

describe('dumpFits', () => {
  it('accepts 1 byte to 5 MiB', () => {
    expect(dumpFits(dump('x', 0, 0))).toBe(false)
    expect(dumpFits(dump('x', 0, 1))).toBe(true)
    expect(dumpFits(dump('x', 0, DUMP_MAX_BYTES))).toBe(true)
    expect(dumpFits(dump('x', 0, DUMP_MAX_BYTES + 1))).toBe(false)
  })
})

describe('dumpsToDelete', () => {
  it('keeps the newest 10, and deletes the older ones beyond them', () => {
    const many = Array.from({ length: 13 }, (_, index) => dump(`d${index}`, index * 1000))
    expect(dumpsToDelete(many, NOW).map((entry) => entry.path).sort()).toEqual(['d10', 'd11', 'd12'])
    expect(many.length - dumpsToDelete(many, NOW).length).toBe(DUMPS_KEPT)
  })

  it('deletes anything over 30 days old even among the newest 10', () => {
    expect(dumpsToDelete([dump('old', DUMP_MAX_AGE_MS + 1), dump('new', 1000)], NOW).map((entry) => entry.path)).toEqual(['old'])
  })
})

describe('the dump folder', () => {
  let dir: string
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function put (folder: string, name: string, ageSec: number): void {
    mkdirSync(join(dir, folder), { recursive: true })
    const path = join(dir, folder, name)
    writeFileSync(path, 'dump')
    const when = Date.now() / 1000 - ageSec
    utimesSync(path, when, when)
  }

  it('lists the .dmp files of pending, completed and reports, and nothing else', () => {
    dir = mkdtempSync(join(tmpdir(), 'orivon-dumps-'))
    put('pending', 'a.dmp', 5)
    put('pending', 'a.meta', 5)
    put('completed', 'b.dmp', 5)
    put('reports', 'c.dmp', 5)
    put('attachments', 'd.dmp', 5)
    expect(listDumps(dir).map((entry) => entry.path.split('/').slice(-2).join('/')).sort()).toEqual(['completed/b.dmp', 'pending/a.dmp', 'reports/c.dmp'])
  })

  it('lists nothing for a folder that does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'orivon-dumps-'))
    expect(listDumps(join(dir, 'missing'))).toEqual([])
  })

  it('prunes old dumps with their .meta, and leaves the newest', () => {
    dir = mkdtempSync(join(tmpdir(), 'orivon-dumps-'))
    put('pending', 'old.dmp', 40 * 24 * 3600)
    put('pending', 'old.meta', 40 * 24 * 3600)
    put('pending', 'new.dmp', 5)
    pruneDumps(dir, Date.now())
    expect(listDumps(dir).map((entry) => entry.path.endsWith('new.dmp'))).toEqual([true])
    expect(() => listDumps(dir)).not.toThrow()
  })
})
