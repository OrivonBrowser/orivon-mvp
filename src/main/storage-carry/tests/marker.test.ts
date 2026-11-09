import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MARKER_FILE, MAX_ATTEMPTS, needsCarry, parseMarker, readMarker, serializeMarker, withOutcome, writeMarker } from '../marker.js'
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

  it('tries again an origin whose pages could not be reached, until its attempts are used', () => {
    let marker = {}
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(needsCarry(marker, ORIGIN), `before attempt ${String(attempt)}`).toBe(true)
      marker = withOutcome(marker, ORIGIN, { status: 'failed', reason: 'no page', report: newReport() }, NOW)
    }
    expect(needsCarry(marker, ORIGIN)).toBe(false)
  })

  it('keeps one row per origin', () => {
    const marker = withOutcome(withOutcome({}, ORIGIN, { status: 'carried', report: newReport() }, NOW), 'https://other.eth', { status: 'failed', reason: 'x', report: newReport() }, NOW)
    expect(Object.keys(marker).sort()).toEqual(['https://other.eth', ORIGIN])
    expect(marker[ORIGIN]).toMatchObject({ status: 'carried', attempts: 1, at: NOW.toISOString() })
    expect(marker['https://other.eth']).toMatchObject({ status: 'failed', reason: 'x' })
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
  ])('says nothing was recorded for %s, since a carry that runs again overwrites nothing', (_what, text) => {
    expect(needsCarry(parseMarker(text), ORIGIN)).toBe(true)
  })

  it('drops a row that is not a row and keeps the others', () => {
    const text = JSON.stringify({ version: 1, origins: { 'https://bad.eth': { status: 'done' }, [ORIGIN]: { status: 'carried', at: 'x', attempts: 1 } } })
    expect(Object.keys(parseMarker(text))).toEqual([ORIGIN])
  })

  it('is read from disk, and a missing file is an empty record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'carry-marker-'))
    dirs.push(dir)
    const path = join(dir, MARKER_FILE)
    expect(readMarker(path)).toEqual({})
    writeMarker(path, withOutcome({}, ORIGIN, { status: 'carried', report: newReport() }, NOW))
    expect(needsCarry(readMarker(path), ORIGIN)).toBe(false)
    writeFileSync(path, '{')
    expect(readMarker(path)).toEqual({})
  })
})
