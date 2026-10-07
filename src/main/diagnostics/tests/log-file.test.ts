import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOG_FILE_LIMIT, LOG_FLUSH_MS, LogFile, readLogTail, TRUNCATED_LINE } from '../log-file.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-log-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('LogFile', () => {
  it('writes buffered lines within the flush delay, and not before', () => {
    const file = new LogFile(join(dir, 'logs'))
    file.append(['one', 'two'])
    expect(() => readFileSync(join(dir, 'logs', 'current.log'), 'utf8')).toThrow()
    vi.advanceTimersByTime(LOG_FLUSH_MS)
    expect(readFileSync(join(dir, 'logs', 'current.log'), 'utf8')).toBe('one\ntwo\n')
  })

  it('writes at once on a synchronous flush', () => {
    const file = new LogFile(join(dir, 'logs'))
    file.append(['fatal'])
    file.flush()
    expect(readFileSync(join(dir, 'logs', 'current.log'), 'utf8')).toBe('fatal\n')
  })

  it('moves the last run\'s file to previous.log', () => {
    const logs = join(dir, 'logs')
    new LogFile(logs).append(['old'])
    writeFileSync(join(logs, 'current.log'), 'old\n')
    const file = new LogFile(logs)
    file.append(['new'])
    file.flush()
    expect(readFileSync(join(logs, 'previous.log'), 'utf8')).toBe('old\n')
    expect(readFileSync(join(logs, 'current.log'), 'utf8')).toBe('new\n')
  })

  it('stops growing at the limit with one line saying so', () => {
    const file = new LogFile(join(dir, 'logs'))
    const chunk = 'x'.repeat(1000)
    for (let index = 0; index < 2200; index += 1) { file.append([chunk]); file.flush() }
    const text = readFileSync(join(dir, 'logs', 'current.log'), 'utf8')
    expect(text.endsWith(`${TRUNCATED_LINE}\n`)).toBe(true)
    expect(text.split(TRUNCATED_LINE)).toHaveLength(2)
    expect(Buffer.byteLength(text)).toBeLessThan(LOG_FILE_LIMIT + 200)
  })

  it('writes nothing, and does not throw, when the directory cannot be made', () => {
    writeFileSync(join(dir, 'blocker'), '')
    const file = new LogFile(join(dir, 'blocker', 'logs'))
    file.append(['a'])
    expect(() => { file.flush() }).not.toThrow()
  })
})

describe('readLogTail', () => {
  it('returns the last lines, oldest first, and nothing for a file that is not there', () => {
    writeFileSync(join(dir, 'x.log'), 'a\nb\nc\nd\n')
    expect(readLogTail(join(dir, 'x.log'), 2)).toEqual(['c', 'd'])
    expect(readLogTail(join(dir, 'x.log'), 10)).toEqual(['a', 'b', 'c', 'd'])
    expect(readLogTail(join(dir, 'missing.log'), 2)).toEqual([])
  })
})
