import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_LINES_PER_MINUTE, HOST_TAIL_ENTRIES, HostLog } from '../host-output.js'
import type { HostLevel, HostLogOptions } from '../host-output.js'
import { LOG_LINE_LIMIT, logLines } from '../log-ring.js'
import { forgetSecrets, noteSecret, scrub } from '../secret-scrub.js'

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

const texts = (written: ReadonlyArray<[HostLevel, string]>): string[] => written.map(([, text]) => text)

afterEach(() => { forgetSecrets() })

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
    expect(texts(written)).toEqual(['[verifier] a slow read', '[verifier] second'])
    const word = bytes('café\n')
    child.stderr.emit('data', word.subarray(0, 4))
    child.stderr.emit('data', word.subarray(4))
    expect(written.at(-1)).toEqual(['warn', '[verifier] café'])
  })

  it('reads a string chunk as it reads bytes, and ends a line at a carriage return and a line feed too', () => {
    const { child, written } = harness()
    child.stderr.emit('data', 'one\r\ntwo\r\n')
    expect(texts(written)).toEqual(['[verifier] one', '[verifier] two'])
  })

  it('leaves out an empty line', () => {
    const { child, written } = harness()
    child.stdout.emit('data', bytes('\n\nfirst\n   \n\nsecond\n'))
    expect(texts(written)).toEqual(['[verifier] first', '[verifier] second'])
  })

  it('keeps a stack under the line it belongs to, as one entry', () => {
    const { child, written } = harness()
    child.stderr.emit('data', bytes('[verifier] request failed: Error: boom\n    at a (file.js:1:1)\n    at b (file.js:2:2)\nnext\n'))
    expect(written).toEqual([
      ['warn', '[verifier] request failed: Error: boom\n    at a (file.js:1:1)\n    at b (file.js:2:2)'],
      ['warn', '[verifier] next']
    ])
  })

  it('writes a long line whole, so the scrub that follows sees a noted key even where the log would cut the line', () => {
    const key = 'k3y-0123456789abcdef'
    noteSecret(key)
    const { child, written } = harness()
    child.stderr.emit('data', bytes(`${'x'.repeat(LOG_LINE_LIMIT - 10)}${key}\n`))
    const text = written[0]?.[1] ?? ''
    expect(text).toContain(key)
    expect(logLines('warn', scrub(text), new Date(0)).join('\n')).not.toContain(key.slice(0, 8))
  })

  it('keeps a line that never ends in memory only up to a bound, and writes what it holds when it passes it', () => {
    const { child, written } = harness()
    child.stderr.emit('data', bytes('y'.repeat(5000)))
    expect(written).toEqual([])
    child.stderr.emit('data', bytes('y'.repeat(4000)))
    expect(written).toEqual([['warn', `[verifier] ${'y'.repeat(9000)}`]])
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
    expect(texts(written)).toEqual(['[verifier] first run', '[verifier] second run'])
  })
})

describe('the last line of a stream', () => {
  it('is written when its stream ends, a line that has no newline included', () => {
    const { child, written } = harness()
    child.stdout.emit('data', bytes('before\nthe last'))
    expect(texts(written)).toEqual(['[verifier] before'])
    child.stdout.emit('end')
    expect(written.at(-1)).toEqual(['log', '[verifier] the last'])
  })

  it('is not written when the process exits: output may still be in the pipe, so a crash line split across reads stays one line', () => {
    const { child, written } = harness()
    child.stderr.emit('data', bytes('[verifier] the crash '))
    child.emit('exit', 1)
    expect(written).toEqual([])
    child.stderr.emit('data', bytes('text'))
    child.stderr.emit('end')
    child.stdout.emit('end')
    expect(written).toEqual([['warn', '[verifier] the crash text']])
  })

  it('is written 2 s after the process exits when its stream has still not ended, and once', () => {
    const { child, written, timers } = harness()
    child.stderr.emit('data', bytes('[verifier] the crash text'))
    child.emit('exit', 1)
    expect(timers.map(({ ms }) => ms)).toEqual([2000])
    timers[0]?.callback()
    expect(written).toEqual([['warn', '[verifier] the crash text']])
    child.stderr.emit('end')
    expect(written).toHaveLength(1)
  })

  it('needs no wait after the exit when both streams have ended', () => {
    const { child, timers } = harness()
    child.stdout.emit('end')
    child.stderr.emit('end')
    child.emit('exit', 0)
    expect(timers).toEqual([])
  })
})

describe('a line that is printed again and again', () => {
  const capped = { linesPerMinute: HOST_LINES_PER_MINUTE }

  it('is written once, and a line says how many times it repeated when a different line arrives', () => {
    const { child, written } = harness(capped)
    child.stderr.emit('data', bytes('[verifier] light client refresh failed: timeout\n'.repeat(4)))
    expect(texts(written)).toEqual(['[verifier] light client refresh failed: timeout'])
    child.stderr.emit('data', bytes('[verifier] something else\n'))
    expect(written).toEqual([
      ['warn', '[verifier] light client refresh failed: timeout'],
      ['warn', '[verifier] the line above repeated 3 times'],
      ['warn', '[verifier] something else']
    ])
  })

  it('says "once" for one repeat, and writes nothing for a line that came only once', () => {
    const { child, written } = harness(capped)
    child.stderr.emit('data', bytes('a\na\nb\nc\n'))
    expect(texts(written)).toEqual(['[verifier] a', '[verifier] the line above repeated once', '[verifier] b', '[verifier] c'])
  })

  it('says how many times at the minute\'s end when nothing different arrives, and writes the next one in full', () => {
    const { child, written, timers, advance } = harness(capped)
    child.stderr.emit('data', bytes('same\nsame\nsame\n'))
    expect(timers.map(({ ms }) => ms)).toEqual([60_000])
    advance(60_000)
    timers[0]?.callback()
    expect(texts(written)).toEqual(['[verifier] same', '[verifier] the line above repeated 2 times'])
    child.stderr.emit('data', bytes('same\n'))
    expect(texts(written).at(-1)).toBe('[verifier] same')
  })

  it('does not count the repeats against the allowance', () => {
    const { child, written } = harness({ linesPerMinute: 4 })
    child.stderr.emit('data', bytes(`first\n${'again\n'.repeat(50)}`))
    child.stderr.emit('data', bytes('second\n'))
    expect(texts(written)).toEqual(['[verifier] first', '[verifier] again', '[verifier] the line above repeated 49 times', '[verifier] second'])
  })

  it('is a repeat only when the level is the same too', () => {
    const { child, written } = harness(capped)
    child.stdout.emit('data', bytes('same\n'))
    child.stderr.emit('data', bytes('same\n'))
    expect(written).toEqual([['log', '[verifier] same'], ['warn', '[verifier] same']])
  })

  it('is one entry when it is a stack', () => {
    const { child, written } = harness(capped)
    const stack = 'Error: boom\n    at a (file.js:1:1)\n'
    child.stderr.emit('data', bytes(stack))
    child.stderr.emit('data', bytes(stack))
    child.stderr.emit('data', bytes('next\n'))
    expect(texts(written)).toEqual(['[verifier] Error: boom\n    at a (file.js:1:1)', '[verifier] the line above repeated once', '[verifier] next'])
  })

  it('is written every time when the host\'s whole output is wanted', () => {
    const { child, written, timers } = harness({ linesPerMinute: undefined })
    child.stderr.emit('data', bytes('same\n'.repeat(5)))
    expect(written).toHaveLength(5)
    expect(timers).toEqual([])
  })
})

describe('a host that writes more than the log can hold', () => {
  const lines = (count: number, from = 1): string => Array.from({ length: count }, (_, index) => `line ${String(from + index)}\n`).join('')
  const asTheyCome = (written: ReadonlyArray<[HostLevel, string]>): string[] => texts(written).filter((text) => text.startsWith('[verifier] line '))

  it('writes a marker at the first line it does not write, and the last few of them with the count when the minute ends', () => {
    const { child, written, timers } = harness({ linesPerMinute: 3 })
    child.stderr.emit('data', bytes(lines(10)))
    expect(texts(written)).toEqual([
      '[verifier] line 1', '[verifier] line 2', '[verifier] line 3',
      '[verifier] more than 3 lines this minute: the rest are counted, and the last 5 are written when the minute ends'
    ])
    expect(written.at(-1)?.[0]).toBe('warn')
    expect(timers.map(({ ms }) => ms)).toEqual([60_000])
    timers[0]?.callback()
    expect(texts(written).slice(4)).toEqual([
      '[verifier] 7 more lines came in the last minute after the first 3; the last 5 entries of them follow',
      '[verifier] line 6', '[verifier] line 7', '[verifier] line 8', '[verifier] line 9', '[verifier] line 10'
    ])
    child.stderr.emit('data', bytes('line 11\n'))
    expect(written.at(-1)).toEqual(['warn', '[verifier] line 11'])
  })

  it('writes the marker once in a minute, and again in the next', () => {
    const { child, written, advance } = harness({ linesPerMinute: 1 })
    child.stderr.emit('data', bytes(lines(4)))
    expect(texts(written).filter((text) => text.includes('more than 1 lines'))).toHaveLength(1)
    advance(60_000)
    child.stderr.emit('data', bytes(lines(3, 5)))
    expect(texts(written).filter((text) => text.includes('more than 1 lines'))).toHaveLength(2)
  })

  it('says the one entry it held back in the singular', () => {
    const { child, written, timers } = harness({ linesPerMinute: 1 })
    child.stderr.emit('data', bytes(lines(2)))
    timers[0]?.callback()
    expect(texts(written).slice(2)).toEqual(['[verifier] 1 more line came in the last minute after the first 1; the last entry of them follows', '[verifier] line 2'])
  })

  it('says it before the next line when the minute is over and the timer has not run yet, and the old timer then does nothing', () => {
    const { child, written, timers, advance } = harness({ linesPerMinute: 2 })
    child.stderr.emit('data', bytes(lines(4)))
    advance(60_000)
    child.stderr.emit('data', bytes('line 5\n'))
    expect(texts(written).slice(3)).toEqual([
      '[verifier] 2 more lines came in the last minute after the first 2; the last 2 entries of them follow',
      '[verifier] line 3', '[verifier] line 4', '[verifier] line 5'
    ])
    const count = written.length
    timers[0]?.callback()
    expect(written).toHaveLength(count)
  })

  it('shares the allowance between the host\'s two streams', () => {
    const { child, written } = harness({ linesPerMinute: 3 })
    child.stdout.emit('data', bytes(lines(2)))
    child.stderr.emit('data', bytes(lines(2, 3)))
    expect(asTheyCome(written)).toHaveLength(3)
  })

  it('counts a stack by its lines, and never cuts one in half', () => {
    const { child, written } = harness({ linesPerMinute: 2 })
    child.stderr.emit('data', bytes('Error: one\n    at a\n    at b\n    at c\n'))
    child.stderr.emit('data', bytes('after\n'))
    expect(texts(written)[0]).toBe('[verifier] Error: one\n    at a\n    at b\n    at c')
    expect(texts(written)).not.toContain('[verifier] after')
  })

  it('keeps only the last entries it held back', () => {
    const { child, written, timers } = harness({ linesPerMinute: 1 })
    const total = HOST_TAIL_ENTRIES + 4
    child.stderr.emit('data', bytes(lines(total)))
    timers[0]?.callback()
    const afterCount = texts(written).slice(texts(written).findIndex((text) => text.includes('came in the last minute')) + 1)
    expect(afterCount).toEqual(Array.from({ length: HOST_TAIL_ENTRIES }, (_, index) => `[verifier] line ${String(total - HOST_TAIL_ENTRIES + 1 + index)}`))
  })

  it('writes the line that counts repeats even when the allowance is used up', () => {
    const { child, written } = harness({ linesPerMinute: 2 })
    child.stderr.emit('data', bytes('a\nb\nb\nb\nc\n'))
    expect(texts(written)).toEqual(['[verifier] a', '[verifier] b', '[verifier] the line above repeated 2 times', '[verifier] more than 2 lines this minute: the rest are counted, and the last 5 are written when the minute ends'])
  })

  it('keeps nothing back when it is asked not to count', () => {
    const { child, written, timers } = harness({ linesPerMinute: undefined })
    child.stderr.emit('data', bytes(lines(500)))
    expect(written).toHaveLength(500)
    expect(timers).toEqual([])
  })
})

describe('what is written when the app quits', () => {
  it('is the repeat count that waits for the minute\'s end, once', () => {
    const { log, child, written } = harness({ linesPerMinute: HOST_LINES_PER_MINUTE })
    child.stderr.emit('data', bytes('same\nsame\nsame\nsame\n'))
    log.flush()
    expect(texts(written)).toEqual(['[verifier] same', '[verifier] the line above repeated 3 times'])
    log.flush()
    expect(written).toHaveLength(2)
  })

  it('is the count of the lines held back with the last of them, and the timer made for that minute then does nothing', () => {
    const { log, child, written, timers } = harness({ linesPerMinute: 2 })
    child.stderr.emit('data', bytes('l1\nl2\nl3\nl4\n'))
    log.flush()
    expect(texts(written).slice(3)).toEqual(['[verifier] 2 more lines came in the last minute after the first 2; the last 2 entries of them follow', '[verifier] l3', '[verifier] l4'])
    const count = written.length
    timers[0]?.callback()
    expect(written).toHaveLength(count)
  })

  it('is nothing when nothing waits', () => {
    const { log, child, written } = harness({ linesPerMinute: HOST_LINES_PER_MINUTE })
    log.flush()
    child.stderr.emit('data', bytes('one\ntwo\n'))
    log.flush()
    expect(texts(written)).toEqual(['[verifier] one', '[verifier] two'])
  })
})

describe('a host whose process also runs a library that prints what it likes', () => {
  const nym = { prefix: '[nym-tunnel]', onlyTagged: 'the Nym library', linesPerMinute: HOST_LINES_PER_MINUTE }

  it('writes only the lines that begin with its tag, and counts the rest as coming from the library', () => {
    const { child, written, timers } = harness(nym)
    child.stderr.emit('data', bytes('[tcp] connecting to a.example:443\n[nym-tunnel] a SOCKS5 connection failed: refused\n[fetch] done\n'))
    expect(written).toEqual([['warn', '[nym-tunnel] a SOCKS5 connection failed: refused']])
    expect(timers.map(({ ms }) => ms)).toEqual([60_000])
    timers[0]?.callback()
    expect(written.at(-1)).toEqual(['warn', '[nym-tunnel] 2 lines from the Nym library were left out in the last minute'])
  })

  it('says "line" and "was" for the one line it left out', () => {
    const { log, child, written } = harness(nym)
    child.stderr.emit('data', bytes('[fetch] done\n'))
    log.flush()
    expect(texts(written)).toEqual(['[nym-tunnel] 1 line from the Nym library was left out in the last minute'])
  })

  it('counts a stack under an untagged line with that line, and says nothing in a minute with nothing left out', () => {
    const { log, child, written } = harness(nym)
    child.stdout.emit('data', bytes('Error: odd\n    at a\n    at b\n'))
    log.flush()
    expect(texts(written)).toEqual(['[nym-tunnel] 3 lines from the Nym library were left out in the last minute'])
    child.stdout.emit('data', bytes('[nym-tunnel] listening\n'))
    log.flush()
    expect(texts(written)).toHaveLength(2)
  })

  it('leaves the tagged lines to the allowance and the repeats like any host\'s', () => {
    const { child, written } = harness({ ...nym, linesPerMinute: 3 })
    child.stderr.emit('data', bytes('[nym-tunnel] a\n[nym-tunnel] a\nlibrary noise\n[nym-tunnel] a\n[nym-tunnel] b\n[nym-tunnel] c\n'))
    expect(texts(written)).toEqual(['[nym-tunnel] a', '[nym-tunnel] the line above repeated 2 times', '[nym-tunnel] b', '[nym-tunnel] more than 3 lines this minute: the rest are counted, and the last 5 are written when the minute ends'])
  })

  it('puts its tag on every line when it is not asked to leave the others out', () => {
    const { child, written } = harness({ prefix: '[nym-tunnel]' })
    child.stderr.emit('data', bytes('[tcp] connecting\n'))
    expect(written).toEqual([['warn', '[nym-tunnel] [tcp] connecting']])
  })
})
