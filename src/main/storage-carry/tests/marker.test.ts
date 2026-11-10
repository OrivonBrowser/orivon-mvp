import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MARKER_FILE, MAX_ATTEMPTS, needsCarry, parseMarker, readMarker, serializeMarker, withFinal, withOutcome, withWriteStarted, writeMarker } from '../marker.js'
import type { CarryMarker } from '../marker.js'
import { newReport } from '../report.js'

const ORIGIN = 'https://wiki.eth'
const NOW = new Date('2026-11-09T10:00:00.000Z')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('which origins still need the carry', () => {
  it('needs it for an origin with no row', () => {
    expect(needsCarry({}, ORIGIN)).toBe(true)
  })

  it('never needs it again once it ran to the end, whatever it left behind', () => {
    const report = newReport()
    report.cookies.failed = 2
    expect(needsCarry(withOutcome({}, ORIGIN, { status: 'carried', report }, NOW), ORIGIN)).toBe(false)
  })

  it('tries again an origin whose carry failed with no page of the app let through, until its attempts are used', () => {
    let marker = {}
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(needsCarry(marker, ORIGIN), `before attempt ${String(attempt)}`).toBe(true)
      marker = withOutcome(marker, ORIGIN, { status: 'failed', reason: 'no page', report: newReport() }, NOW)
    }
    expect(needsCarry(marker, ORIGIN)).toBe(false)
  })

  it('never tries again a failed carry once a page of the app was let through, whatever attempts are left', () => {
    const failed = withOutcome({}, ORIGIN, { status: 'failed', reason: 'a page stopped', report: newReport() }, NOW)
    expect(needsCarry(failed, ORIGIN)).toBe(true)
    const final = withFinal(failed, ORIGIN)
    expect(final[ORIGIN]).toMatchObject({ status: 'failed', final: true, attempts: 1 })
    expect(needsCarry(final, ORIGIN)).toBe(false)
  })

  it('records a carry that failed with a page waiting as final from the start', () => {
    const marker = withOutcome({}, ORIGIN, { status: 'failed', reason: 'ran past its limit', report: newReport(), final: true }, NOW)
    expect(marker[ORIGIN]?.final).toBe(true)
    expect(needsCarry(marker, ORIGIN)).toBe(false)
  })

  it('marks only a failed row final: a carried row and an unknown origin are left as they are', () => {
    const carried = withOutcome({}, ORIGIN, { status: 'carried', report: newReport() }, NOW)
    expect(withFinal(carried, ORIGIN)).toBe(carried)
    expect(withFinal({}, ORIGIN)).toEqual({})
  })

  it('keeps one row per origin', () => {
    const marker = withOutcome(withOutcome({}, ORIGIN, { status: 'carried', report: newReport() }, NOW), 'https://other.eth', { status: 'failed', reason: 'x', report: newReport() }, NOW)
    expect(Object.keys(marker).sort()).toEqual(['https://other.eth', ORIGIN])
    expect(marker[ORIGIN]).toMatchObject({ status: 'carried', attempts: 1, at: NOW.toISOString() })
    expect(marker['https://other.eth']).toMatchObject({ status: 'failed', reason: 'x' })
  })
})

describe('a carry that stops the browser in the middle', () => {
  it('leaves a row behind from the moment it starts to write, so that it is not tried at every start for ever', () => {
    let marker: CarryMarker = {}
    for (let start = 1; start <= MAX_ATTEMPTS; start++) {
      expect(needsCarry(marker, ORIGIN), `before start ${String(start)}`).toBe(true)
      marker = withWriteStarted(marker, ORIGIN, NOW)
      expect(marker[ORIGIN]).toMatchObject({ status: 'failed', attempts: start, unfinished: true })
    }
    expect(needsCarry(marker, ORIGIN)).toBe(false)
  })

  it('gives a carry that did not start to write no row, so a crash before any write is tried again', () => {
    expect(needsCarry({}, ORIGIN)).toBe(true)
  })

  it('counts a start once: the outcome of a carry that wrote takes the place of the row it left, with the same attempts', () => {
    const started = withWriteStarted({}, ORIGIN, NOW)
    const carried = withOutcome(started, ORIGIN, { status: 'carried', report: newReport() }, NOW)
    expect(carried[ORIGIN]).toMatchObject({ status: 'carried', attempts: 1 })
    expect(carried[ORIGIN]).not.toHaveProperty('unfinished')
    const failed = withOutcome(withWriteStarted({}, ORIGIN, NOW), ORIGIN, { status: 'failed', reason: 'a page stopped', report: newReport() }, NOW)
    expect(failed[ORIGIN]).toMatchObject({ status: 'failed', attempts: 1, reason: 'a page stopped' })
    expect(failed[ORIGIN]).not.toHaveProperty('unfinished')
  })

  it('counts the start that crashed and the one that came after it', () => {
    const crashed = withWriteStarted({}, ORIGIN, NOW)
    const second = withOutcome(withWriteStarted(crashed, ORIGIN, NOW), ORIGIN, { status: 'carried', report: newReport() }, NOW)
    expect(second[ORIGIN]).toMatchObject({ status: 'carried', attempts: 2 })
  })

  it('keeps the row through the file, and a row of another origin is untouched', () => {
    const marker = withWriteStarted(withOutcome({}, 'https://other.eth', { status: 'carried', report: newReport() }, NOW), ORIGIN, NOW)
    expect(parseMarker(serializeMarker(marker))).toEqual(marker)
    expect(marker['https://other.eth']).toMatchObject({ status: 'carried', attempts: 1 })
  })

  it('is marked final like any failed row, once a page of the app was let through', () => {
    expect(needsCarry(withFinal(withWriteStarted({}, ORIGIN, NOW), ORIGIN), ORIGIN)).toBe(false)
  })
})

describe('the file', () => {
  it('reads back what was written, with the report', () => {
    const report = newReport()
    report.databases.carried = 3
    report.problems.push('cookie "sid": refused')
    const marker = withOutcome({}, ORIGIN, { status: 'carried', report }, NOW)
    expect(parseMarker(serializeMarker(marker))).toEqual(marker)
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['another version', JSON.stringify({ version: 99, origins: { [ORIGIN]: { status: 'carried', at: 'x', attempts: 1 } } })],
    ['origins that are not an object', JSON.stringify({ version: 1, origins: [] })]
  ])('is no record for %s, so the carry does nothing rather than replace what the website session holds', (_what, text) => {
    expect(parseMarker(text)).toBeUndefined()
  })

  it('drops a row that is not a row and keeps the others', () => {
    const text = JSON.stringify({ version: 1, origins: { 'https://bad.eth': { status: 'done' }, [ORIGIN]: { status: 'carried', at: 'x', attempts: 1 } } })
    expect(Object.keys(parseMarker(text) ?? {})).toEqual([ORIGIN])
  })

  it('is read from disk; a missing file is an empty record and an unreadable one is no record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'carry-marker-'))
    dirs.push(dir)
    const path = join(dir, MARKER_FILE)
    expect(readMarker(path)).toEqual({})
    writeMarker(path, withOutcome({}, ORIGIN, { status: 'carried', report: newReport() }, NOW))
    expect(needsCarry(readMarker(path) ?? {}, ORIGIN)).toBe(false)
    writeFileSync(path, '{')
    expect(readMarker(path)).toBeUndefined()
  })
})
