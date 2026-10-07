import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CrashStore, RunMarkerFile } from '../crash-store.js'
import { MAX_SENT, parseSent, SentStore, summaryOf, SUMMARY_LIMIT, withSent } from '../sent-reports.js'
import type { SentReport } from '../sent-reports.js'
import { CRASH } from './report-fixtures.js'

const NOW = Date.parse('2026-10-07T12:00:00Z')
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-diag-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('CrashStore', () => {
  it('writes each record to disk before add returns, and a new store reads it back', () => {
    new CrashStore(dir, NOW).add(CRASH, NOW)
    expect(JSON.parse(readFileSync(join(dir, 'crashes.json'), 'utf8'))).toHaveLength(1)
    expect(new CrashStore(dir, NOW).get(CRASH.id)).toEqual(CRASH)
  })

  it('records and clears the report id of a crash', () => {
    const store = new CrashStore(dir, NOW)
    store.add(CRASH, NOW)
    store.markReported(CRASH.id, 'e'.repeat(32))
    expect(new CrashStore(dir, NOW).get(CRASH.id)?.reportedAs).toBe('e'.repeat(32))
    store.markReported(CRASH.id, undefined)
    expect(new CrashStore(dir, NOW).get(CRASH.id)?.reportedAs).toBeUndefined()
  })

  it('starts empty from a corrupt file, and drops records over 30 days old when it loads', () => {
    writeFileSync(join(dir, 'crashes.json'), '{broken')
    expect(new CrashStore(dir, NOW).list()).toEqual([])
    writeFileSync(join(dir, 'crashes.json'), JSON.stringify([CRASH]))
    expect(new CrashStore(dir, NOW + 31 * 24 * 3600 * 1000).list()).toEqual([])
  })

  it('does not throw when the disk refuses, and keeps the record for this run', () => {
    writeFileSync(join(dir, 'blocker'), '')
    const store = new CrashStore(join(dir, 'blocker', 'sub'), NOW)
    expect(() => { store.add(CRASH, NOW) }).not.toThrow()
    expect(store.get(CRASH.id)).toBeDefined()
  })
})

describe('RunMarkerFile', () => {
  it('writes, reads and clears the marker', () => {
    const marker = new RunMarkerFile(dir)
    expect(marker.read()).toBeUndefined()
    marker.write({ sessionId: 's', pid: 3, startedAt: 9 })
    expect(marker.read()).toEqual({ sessionId: 's', pid: 3, startedAt: 9 })
    marker.clear()
    expect(marker.read()).toBeUndefined()
    expect(existsSync(join(dir, 'running.json'))).toBe(false)
  })

  it('clearing a marker that is not there is fine', () => {
    expect(() => { new RunMarkerFile(dir).clear() }).not.toThrow()
  })
})

describe('sent reports', () => {
  const entry = (n: number): SentReport => ({ reportId: n.toString(16).padStart(32, '0'), at: '2026-10-07T11:00:00Z', summary: `r${n}` })

  it('summarises by the first line, cut short', () => {
    expect(summaryOf('  first\nsecond ')).toBe('first')
    expect(summaryOf('x'.repeat(500))).toHaveLength(SUMMARY_LIMIT)
  })

  it('keeps the newest 20 and replaces a retried id', () => {
    let list: SentReport[] = []
    for (let n = 0; n < 25; n += 1) list = withSent(list, entry(n))
    expect(list).toHaveLength(MAX_SENT)
    expect(list[0]?.summary).toBe('r5')
    expect(withSent(list, { ...entry(24), summary: 'again' }).filter((sent) => sent.reportId === entry(24).reportId)).toHaveLength(1)
  })

  it('stores to disk, lists newest first, and deletes one', () => {
    const store = new SentStore(dir)
    store.add(entry(1))
    store.add(entry(2))
    expect(new SentStore(dir).all().map((sent) => sent.summary)).toEqual(['r2', 'r1'])
    store.remove(entry(2).reportId)
    expect(new SentStore(dir).all().map((sent) => sent.summary)).toEqual(['r1'])
  })

  it('ignores malformed entries', () => {
    expect(parseSent(JSON.stringify([entry(1), { reportId: 'short' }, 3]))).toEqual([entry(1)])
    expect(parseSent('nope')).toEqual([])
  })
})
