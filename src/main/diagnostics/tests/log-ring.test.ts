import { describe, expect, it, vi } from 'vitest'
import { captureConsole, formatArgs, LOG_LINE_LIMIT, LOG_RING_LINES, LogRing, logLines } from '../log-ring.js'
import type { LogLevel } from '../log-ring.js'

const AT = new Date('2026-10-07T12:00:00.000Z')

describe('logLines', () => {
  it('prefixes the time and the level, and indents the rest of a multi-line message', () => {
    expect(logLines('error', 'boom\n  at a (x.ts:1)\nat b', AT)).toEqual([
      '2026-10-07T12:00:00.000Z ERROR boom',
      '      at a (x.ts:1)',
      '    at b'
    ])
  })

  it('cuts every line to the limit', () => {
    const [line] = logLines('log', 'x'.repeat(5000), AT)
    expect(line?.length).toBe(LOG_LINE_LIMIT)
    expect(logLines('log', `a\n${'y'.repeat(5000)}`, AT)[1]?.length).toBe(LOG_LINE_LIMIT)
  })
})

describe('formatArgs', () => {
  it('renders like the console does', () => {
    expect(formatArgs(['a %s', 'b', { c: 1 }])).toBe('a b { c: 1 }')
    expect(formatArgs([new Error('bad')])).toContain('Error: bad')
  })
})

describe('LogRing', () => {
  it('keeps the newest 1000 lines, oldest first', () => {
    const ring = new LogRing()
    for (let index = 0; index < LOG_RING_LINES + 50; index += 1) ring.push('log', `line ${index}`, AT)
    const lines = ring.lines()
    expect(lines).toHaveLength(LOG_RING_LINES)
    expect(lines[0]).toContain('line 50')
    expect(lines.at(-1)).toContain(`line ${LOG_RING_LINES + 49}`)
  })

  it('hands back a copy, so a caller cannot change the ring', () => {
    const ring = new LogRing()
    ring.push('log', 'a', AT)
    ring.lines().length = 0
    expect(ring.lines()).toHaveLength(1)
  })
})

describe('captureConsole', () => {
  function fakeConsole (): Pick<Console, LogLevel> & { printed: string[] } {
    const printed: string[] = []
    const make = (level: string) => (...args: unknown[]): void => { printed.push(`${level}:${args.join(' ')}`) }
    return { printed, log: make('log'), info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug') }
  }

  it('still prints, and tells the sink the level and the text', () => {
    const target = fakeConsole()
    const seen: string[] = []
    captureConsole(target, (level, text) => { seen.push(`${level}|${text}`) })
    target.warn('careful', 3)
    expect(target.printed).toEqual(['warn:careful 3'])
    expect(seen).toEqual(['warn|careful 3'])
  })

  it('survives a sink that throws, and does not record what the sink itself logs', () => {
    const target = fakeConsole()
    const sink = vi.fn((level: LogLevel) => { if (level === 'log') target.error('inner'); throw new Error('sink broke') })
    captureConsole(target, sink)
    expect(() => { target.log('x') }).not.toThrow()
    expect(sink).toHaveBeenCalledTimes(1)
    expect(target.printed).toEqual(['log:x', 'error:inner'])
  })

  it('puts the console back when asked', () => {
    const target = fakeConsole()
    const original = target.log
    const restore = captureConsole(target, () => {})
    expect(target.log).not.toBe(original)
    restore()
    expect(target.log).toBe(original)
  })
})
