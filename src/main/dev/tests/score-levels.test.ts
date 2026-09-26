import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readScoreLevelOverrides } from '../score-levels.js'

describe('readScoreLevelOverrides', () => {
  let dir: string
  const ORIGINAL_ENV = { ...process.env }
  const NONE = { website: new Map(), delivery: new Map() }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orivon-score-levels-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    process.env = { ...ORIGINAL_ENV }
    vi.restoreAllMocks()
  })

  const overridesFile = (content: string): string => {
    const path = join(dir, 'overrides.json')
    writeFileSync(path, content)
    return path
  }

  it('reads nothing when ORIVON_DEV_ORIGINS is not set, even with a valid file', () => {
    delete process.env['ORIVON_DEV_ORIGINS']
    process.env['ORIVON_SCORE_LEVELS_FILE'] = overridesFile('{"https://app.example": {"website": 4}}')
    expect(readScoreLevelOverrides()).toEqual(NONE)
  })

  it('reads nothing when ORIVON_SCORE_LEVELS_FILE is not set, even in dev mode', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    delete process.env['ORIVON_SCORE_LEVELS_FILE']
    expect(readScoreLevelOverrides()).toEqual(NONE)
  })

  it('reads a website and a delivery override for one origin', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_SCORE_LEVELS_FILE'] = overridesFile('{"https://app.example": {"website": 4, "delivery": 3}}')
    const overrides = readScoreLevelOverrides()
    expect(overrides.website.get('https://app.example')).toBe(4)
    expect(overrides.delivery.get('https://app.example')).toBe(3)
  })

  it('accepts either field alone', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_SCORE_LEVELS_FILE'] = overridesFile('{"https://a.example": {"website": 3}, "https://b.example": {"delivery": 2}}')
    const overrides = readScoreLevelOverrides()
    expect(overrides.website.get('https://a.example')).toBe(3)
    expect(overrides.delivery.get('https://a.example')).toBeUndefined()
    expect(overrides.website.get('https://b.example')).toBeUndefined()
    expect(overrides.delivery.get('https://b.example')).toBe(2)
  })

  // Spliced into a per-origin lookup, never trusted raw -- this file reads a
  // map from OUTSIDE this process, so a key that does not round-trip through
  // the same canonical-origin parser the rest of the browser uses is dropped
  // rather than silently mismatching every real lookup.
  it('drops an entry whose key is not a canonical origin', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    for (const bad of ['app.example', 'https://App.example', 'https://app.example/', 'not a url', 'ftp://app.example']) {
      process.env['ORIVON_SCORE_LEVELS_FILE'] = overridesFile(JSON.stringify({ [bad]: { website: 4 } }))
      const overrides = readScoreLevelOverrides()
      expect(overrides.website.size).toBe(0)
    }
  })

  it('drops a website value outside 1-4, and a delivery value outside 1-3', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    for (const bad of [0, 5, 2.5, Number.NaN, '4', null]) {
      process.env['ORIVON_SCORE_LEVELS_FILE'] = overridesFile(JSON.stringify({ 'https://app.example': { website: bad } }))
      expect(readScoreLevelOverrides().website.size).toBe(0)
    }
    for (const bad of [0, 4, 1.5]) {
      process.env['ORIVON_SCORE_LEVELS_FILE'] = overridesFile(JSON.stringify({ 'https://app.example': { delivery: bad } }))
      expect(readScoreLevelOverrides().delivery.size).toBe(0)
    }
  })

  it('keeps the valid entries and drops only the bad ones', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_SCORE_LEVELS_FILE'] = overridesFile(JSON.stringify({
      'https://good.example': { website: 4 },
      'bad-origin': { website: 4 },
      'https://also-good.example': { website: 2, delivery: 2 }
    }))
    const overrides = readScoreLevelOverrides()
    expect(overrides.website.size).toBe(2)
    expect(overrides.website.get('https://good.example')).toBe(4)
    expect(overrides.website.get('https://also-good.example')).toBe(2)
    expect(overrides.delivery.get('https://also-good.example')).toBe(2)
  })

  it('does not throw on a missing file, and reads nothing', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_SCORE_LEVELS_FILE'] = join(dir, 'does-not-exist.json')
    expect(readScoreLevelOverrides()).toEqual(NONE)
  })

  it('does not throw on malformed JSON, or JSON that is not an object map', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    for (const content of ['not json', '[1, 2, 3]', '"a string"', 'null']) {
      process.env['ORIVON_SCORE_LEVELS_FILE'] = overridesFile(content)
      expect(readScoreLevelOverrides()).toEqual(NONE)
    }
  })

  it('logs every accepted entry loudly, and names dropped keys', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_SCORE_LEVELS_FILE'] = overridesFile(JSON.stringify({
      'https://good.example': { website: 4 },
      'bad-origin': { website: 4 }
    }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    readScoreLevelOverrides()
    const logged = spy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('https://good.example')
    expect(logged).toContain('bad-origin')
  })
})
