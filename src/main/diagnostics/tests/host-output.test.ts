import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { HOST_LINES_PER_MINUTE, HostLog } from '../host-output.js'
import type { HostLevel, HostLogOptions } from '../host-output.js'
import { LOG_LINE_LIMIT, LOG_RING_LINES } from '../log-ring.js'

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
}

const bytes = (text: string): Buffer => Buffer.from(text)

/** A host's log with a clock and a timer the test drives, and the child whose output it reads. */
function harness (options: Partial<HostLogOptions> = {}) {
  const written: Array<[HostLevel, string]> = []
  const timers: Array<{ callback: () => void, ms: number }> = []
  let time = 1_000_000
  const log = new HostLog({
    prefix: '[verifier]',
    write: (level, text) => { written.push([level, text]) },
    now: () => time,
    setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length },
    ...options
  })
  const child = new FakeChild()
  log.attach(child)
  return { log, child, written, timers, advance: (ms: number) => { time += ms } }
}

describe('what a host prints', () => {
  it('is written at log for stdout and warn for stderr, with the host\'s tag put in front of a line that has none', () => {
    const { child, written } = harness()
    child.stdout.emit('data', bytes('a plain line\n'))
    child.stderr.emit('data', bytes('[verifier] swarm: a site mounted in 12 ms\n'))
    expect(written).toEqual([
      ['log', '[verifier] a plain line'],
      ['warn', '[verifier] swarm: a site mounted in 12 ms']
    ])
  })

  it('joins a line cut in two by the chunks, whole characters included', () => {
    const { child, written } = harness()
    child.stderr.emit('data', bytes('[verifier] a sl'))
    expect(written).toEqual([])
    child.stderr.emit('data', bytes('ow read\n[verifier] second\n'))
    expect(written.map(([, text]) => text)).toEqual(['[verifier] a slow read', '[verifier] second'])
    const word = bytes('café\n')
    child.stderr.emit('data', word.subarray(0, 4))
    child.stderr.emit('data', word.subarray(4))
    expect(written.at(-1)).toEqual(['warn', '[verifier] café'])
  })

  it('reads a string chunk as it reads bytes, and ends a line at a carriage return and a line feed too', () => {
    const { child, written } = harness()
    child.stderr.emit('data', 'one\r\ntwo\r\n')
    expect(written.map(([, text]) => text)).toEqual(['[verifier] one', '[verifier] two'])
  })

  it('leaves out an empty line', () => {
    const { child, written } = harness()
    child.stdout.emit('data', bytes('\n\nfirst\n   \n\nsecond\n'))
    expect(written.map(([, text]) => text)).toEqual(['[verifier] first', '[verifier] second'])
  })

  it('keeps a stack under the line it belongs to, as one entry', () => {
    const { child, written } = harness()
    child.stderr.emit('data', bytes('[verifier] request failed: Error: boom\n    at a (file.js:1:1)\n    at b (file.js:2:2)\nnext\n'))
    expect(written).toEqual([
      ['warn', '[verifier] request failed: Error: boom\n    at a (file.js:1:1)\n    at b (file.js:2:2)'],
      ['warn', '[verifier] next']
    ])
  })

  it('cuts a line to the length the log keeps', () => {
    const { child, written } = harness()
    child.stderr.emit('data', bytes(`${'x'.repeat(5000)}\n`))
    expect(written).toEqual([['warn', `[verifier] ${'x'.repeat(LOG_LINE_LIMIT)}`]])
  })

  it('writes a last line that has no newline when its stream ends', () => {
    const { child, written } = harness()
    child.stdout.emit('data', bytes('before\nthe last'))
    expect(written.map(([, text]) => text)).toEqual(['[verifier] before'])
    child.stdout.emit('end')
    expect(written.at(-1)).toEqual(['log', '[verifier] the last'])
  })

  it('writes it when the process exits before its streams end, and once', () => {
    const { child, written } = harness()
    child.stderr.emit('data', bytes('[verifier] the crash text'))
    child.emit('exit', 1)
    child.stderr.emit('end')
    expect(written).toEqual([['warn', '[verifier] the crash text']])
  })

  it('writes a line that never ends once it is longer than the log keeps, so memory does not grow', () => {
    const { child, written } = harness()
    child.stderr.emit('data', bytes('y'.repeat(9000)))
    expect(written).toEqual([['warn', `[verifier] ${'y'.repeat(LOG_LINE_LIMIT)}`]])
  })

  it('reads a child that was forked without piped output as one that prints nothing', () => {
    const { log, written } = harness()
    expect(() => { log.attach({ on: () => undefined }) }).not.toThrow()
    expect(() => { log.attach({ stdout: null, stderr: null, on: () => undefined }) }).not.toThrow()
    expect(written).toEqual([])
  })

  it('keeps the streams of every child the host is forked as, one after another', () => {
    const { log, child, written } = harness()
    child.stderr.emit('data', bytes('first run\n'))
    const next = new FakeChild()
    log.attach(next)
    next.stderr.emit('data', bytes('second run\n'))
    expect(written.map(([, text]) => text)).toEqual(['[verifier] first run', '[verifier] second run'])
  })
})

describe('a host that writes more than the log can hold', () => {
  const lines = (count: number, from = 1): string => Array.from({ length: count }, (_, index) => `line ${String(from + index)}\n`).join('')

  it('keeps the first lines of the minute, and says how many it did not keep when the minute ends', () => {
    const { child, written, timers } = harness({ linesPerMinute: 3 })
    child.stderr.emit('data', bytes(lines(5)))
    expect(written.map(([, text]) => text)).toEqual(['[verifier] line 1', '[verifier] line 2', '[verifier] line 3'])
    expect(timers.map(({ ms }) => ms)).toEqual([60_000])
    timers[0]?.callback()
    expect(written.at(-1)).toEqual(['warn', '[verifier] 2 more lines in the last minute were not kept (at most 3 a minute are)'])
    child.stderr.emit('data', bytes('line 6\n'))
    expect(written.at(-1)).toEqual(['warn', '[verifier] line 6'])
    expect(written).toHaveLength(5)
  })

  it('says it before the next line when the minute is over and the timer has not run yet, and the old timer then does nothing', () => {
    const { child, written, timers, advance } = harness({ linesPerMinute: 2 })
    child.stderr.emit('data', bytes(lines(4)))
    advance(60_000)
    child.stderr.emit('data', bytes('line 5\n'))
    expect(written.map(([, text]) => text).slice(2)).toEqual(['[verifier] 2 more lines in the last minute were not kept (at most 2 a minute are)', '[verifier] line 5'])
    timers[0]?.callback()
    expect(written).toHaveLength(4)
  })

  it('shares the allowance between the host\'s two streams', () => {
    const { child, written } = harness({ linesPerMinute: 3 })
    child.stdout.emit('data', bytes(lines(2)))
    child.stderr.emit('data', bytes(lines(2, 3)))
    expect(written).toHaveLength(3)
  })

  it('counts a stack by its lines, and never cuts one in half', () => {
    const { child, written } = harness({ linesPerMinute: 2 })
    child.stderr.emit('data', bytes('Error: one\n    at a\n    at b\n    at c\n'))
    child.stderr.emit('data', bytes('after\n'))
    expect(written.map(([, text]) => text)).toEqual(['[verifier] Error: one\n    at a\n    at b\n    at c'])
  })

  it('keeps nothing back when it is asked not to count', () => {
    const { child, written, timers } = harness({ linesPerMinute: undefined })
    child.stderr.emit('data', bytes(lines(500)))
    expect(written).toHaveLength(500)
    expect(timers).toEqual([])
  })

  it('lets three hosts at the allowance fill under a quarter of the ring in a minute', () => {
    expect(HOST_LINES_PER_MINUTE * 3).toBeLessThan(LOG_RING_LINES / 4)
  })
})
