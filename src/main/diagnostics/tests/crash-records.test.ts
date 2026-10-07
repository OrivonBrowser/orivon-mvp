import { describe, expect, it } from 'vitest'
import { errorFacts, idFromBytes, lastRunCrash, MAX_RECORDS, newest, parseMarker, parseRecords, pruneRecords, RECORD_MAX_AGE_MS, stamp, uncleanExitRecord, withRecord, withReported } from '../crash-records.js'
import type { CrashRecord } from '../crash-records.js'

const NOW = Date.parse('2026-10-07T12:00:00Z')

function record (overrides: Partial<CrashRecord> = {}): CrashRecord {
  return { id: 'aaaaaaaaaaaaaaaa', sessionId: 's1', kind: 'renderer', at: '2026-10-07T11:00:00Z', process: 'tab', reason: 'crashed', exitCode: 133, message: '', stack: '', ...overrides }
}

describe('stamp and ids', () => {
  it('writes UTC to the second', () => {
    expect(stamp(Date.parse('2026-10-07T12:34:56.789Z'))).toBe('2026-10-07T12:34:56Z')
  })

  it('makes a 16-character lowercase hex id from eight bytes', () => {
    expect(idFromBytes(Uint8Array.from([0, 1, 15, 16, 255, 171, 205, 239]))).toBe('00010f10ffabcdef')
  })
})

describe('errorFacts', () => {
  it('reads an Error, a string and anything else', () => {
    const error = new Error('bad')
    expect(errorFacts(error)).toEqual({ message: 'bad', stack: error.stack })
    expect(errorFacts('plain')).toEqual({ message: 'plain', stack: '' })
    expect(errorFacts({ code: 7 })).toEqual({ message: '{"code":7}', stack: '' })
    expect(errorFacts(undefined).message).toBe('undefined')
  })

  it('does not throw on a value JSON cannot write', () => {
    const loop: Record<string, unknown> = {}
    loop['self'] = loop
    expect(errorFacts(loop).message).toBe('[object Object]')
  })
})

describe('the record store rules', () => {
  it('keeps the newest 30 and drops older than 30 days', () => {
    const many = Array.from({ length: 40 }, (_, index) => record({ id: index.toString(16).padStart(16, '0') }))
    const kept = pruneRecords(many, NOW)
    expect(kept).toHaveLength(MAX_RECORDS)
    expect(kept[0]?.id).toBe((10).toString(16).padStart(16, '0'))
    const old = record({ id: 'bbbbbbbbbbbbbbbb', at: stamp(NOW - RECORD_MAX_AGE_MS - 1000) })
    expect(pruneRecords([old, record()], NOW).map((entry) => entry.id)).toEqual(['aaaaaaaaaaaaaaaa'])
  })

  it('replaces a record with the same id rather than keeping two', () => {
    const next = withRecord([record({ message: 'a' })], record({ message: 'b' }), NOW)
    expect(next).toHaveLength(1)
    expect(next[0]?.message).toBe('b')
  })

  it('lists the newest first', () => {
    const list = [record({ id: '1111111111111111', at: '2026-10-07T09:00:00Z' }), record({ id: '2222222222222222', at: '2026-10-07T11:00:00Z' })]
    expect(newest(list, 1).map((entry) => entry.id)).toEqual(['2222222222222222'])
  })

  it('marks a record reported, and unmarks it', () => {
    const marked = withReported([record()], 'aaaaaaaaaaaaaaaa', 'f'.repeat(32))
    expect(marked[0]?.reportedAs).toBe('f'.repeat(32))
    expect(withReported(marked, 'aaaaaaaaaaaaaaaa', undefined)[0]).not.toHaveProperty('reportedAs')
  })
})

describe('parseRecords', () => {
  it('keeps the well-formed records and drops the rest, never throwing', () => {
    expect(parseRecords(JSON.stringify([record(), { id: 'x' }, 5, null]))).toEqual([record()])
    expect(parseRecords('not json')).toEqual([])
    expect(parseRecords('{"a":1}')).toEqual([])
  })

  it('refuses a record whose time or kind is not one of ours', () => {
    expect(parseRecords(JSON.stringify([record({ at: 'yesterday' }), record({ kind: 'other' as never })]))).toEqual([])
  })
})

describe('parseMarker', () => {
  it('reads a marker and refuses a malformed one', () => {
    expect(parseMarker('{"sessionId":"s","pid":4,"startedAt":9}')).toEqual({ sessionId: 's', pid: 4, startedAt: 9 })
    expect(parseMarker('{"sessionId":"","pid":4,"startedAt":9}')).toBeUndefined()
    expect(parseMarker('[]')).toBeUndefined()
    expect(parseMarker('nope')).toBeUndefined()
  })
})

describe('uncleanExitRecord', () => {
  const marker = { sessionId: 'prev', pid: 7, startedAt: Date.parse('2026-10-07T08:00:00Z') }

  it('says nothing when the last run ended in an orderly quit (no marker)', () => {
    expect(uncleanExitRecord(undefined, [], 'c'.repeat(16), undefined)).toBeUndefined()
  })

  it('makes an unclean-exit record dated at the run\'s start', () => {
    expect(uncleanExitRecord(marker, [], 'c'.repeat(16), undefined)).toMatchObject({ kind: 'unclean-exit', sessionId: 'prev', at: '2026-10-07T08:00:00Z', process: 'main', reason: 'abnormal-exit', exitCode: null })
  })

  it('dates it at a native dump\'s time when there is one, so the dump matches it', () => {
    expect(uncleanExitRecord(marker, [], 'c'.repeat(16), Date.parse('2026-10-07T09:30:00Z'))).toMatchObject({ at: '2026-10-07T09:30:00Z', reason: 'crashed' })
  })

  it('is not made when that run already left a fatal record, which is the same event', () => {
    expect(uncleanExitRecord(marker, [record({ sessionId: 'prev', kind: 'main-error' })], 'c'.repeat(16), undefined)).toBeUndefined()
  })

  it('is still made when that run only left a renderer crash', () => {
    expect(uncleanExitRecord(marker, [record({ sessionId: 'prev', kind: 'renderer' })], 'c'.repeat(16), undefined)?.kind).toBe('unclean-exit')
  })
})

describe('lastRunCrash', () => {
  it('finds the previous run\'s unreported fatal or unclean record, not a tab crash and not a sent one', () => {
    const list = [
      record({ id: '1111111111111111', sessionId: 'prev', kind: 'renderer' }),
      record({ id: '2222222222222222', sessionId: 'prev', kind: 'main-error', reportedAs: 'x'.repeat(32) }),
      record({ id: '3333333333333333', sessionId: 'prev', kind: 'unclean-exit' }),
      record({ id: '4444444444444444', sessionId: 'other', kind: 'main-error' })
    ]
    expect(lastRunCrash(list, 'prev')?.id).toBe('3333333333333333')
    expect(lastRunCrash(list, undefined)).toBeUndefined()
    expect(lastRunCrash(list.slice(0, 2), 'prev')).toBeUndefined()
  })
})
