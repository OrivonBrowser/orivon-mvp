import { Console as NodeConsole } from 'node:console'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Console } from '../console-class.js'
import { renderTable } from '../console-table.js'

/** A writable that keeps what it is given, real enough for Node's own Console (it listens for stream errors). */
function sink (): Writable & { text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({ write (chunk: Buffer, _encoding, done) { chunks.push(chunk.toString()); done() } })
  return Object.assign(stream, { text: () => chunks.join('') })
}

/** What a console writes to `stdout` and to `stderr` for `scenario`, for ours and for Node's. */
function both (scenario: (console: Console | NodeConsole) => void): [{ out: string, err: string }, { out: string, err: string }] {
  const run = (Class: typeof Console | typeof NodeConsole): { out: string, err: string } => {
    const out = sink()
    const err = sink()
    scenario(new Class({ stdout: out, stderr: err }) as Console)
    return { out: out.text(), err: err.text() }
  }
  return [run(Console), run(NodeConsole)]
}

describe('Console', () => {
  it.each([
    ['log, info, debug and dirxml write to stdout, warn and error to stderr', (c: Console | NodeConsole) => { c.log('a %s', 'b', 1); c.info({ x: [1, 2] }); c.debug('d'); c.dirxml('x'); c.warn('w'); c.error(new Error('e').message, 2) }],
    ['dir inspects with the options it is given', (c: Console | NodeConsole) => { c.dir({ a: { b: { c: {} } } }, { depth: 0 }); c.dir({ plain: 1, list: [1, 2] }) }],
    ['group indents every line, including the lines of a multi-line message, until groupEnd', (c: Console | NodeConsole) => { c.group('outer'); c.log('a\nb'); c.group(); c.error('deep'); c.groupEnd(); c.groupCollapsed('c'); c.groupEnd(); c.groupEnd(); c.groupEnd(); c.log('flat') }],
    ['count and countReset', (c: Console | NodeConsole) => { c.count(); c.count(); c.count('x'); c.countReset(); c.count() }],
    ['assert prints only a failed assertion, with or without a message', (c: Console | NodeConsole) => { c.assert(true, 'no'); c.assert(false); c.assert(false, 'bad %s', 'thing'); c.assert(0, { a: 1 }) }],
    ['a method works detached from its console', (c: Console | NodeConsole) => { const { log } = c; log('detached') }]
  ])('%s, as Node\'s does', (_name, scenario) => {
    const [mine, node] = both(scenario)
    expect(mine).toEqual(node)
    expect(mine.out + mine.err).not.toBe('')
  })

  it('looks the stream\'s write up when it writes', () => {
    const out = sink()
    const console = new Console({ stdout: out })
    const seen: string[] = []
    out.write = ((chunk: string) => { seen.push(chunk); return true }) as typeof out.write
    console.log('patched')
    expect(seen).toEqual(['patched\n'])
  })

  it('writes errors to stdout when it has no stderr, and ignores a failing stream unless told not to', () => {
    const out = sink()
    new Console(out).error('both')
    expect(out.text()).toBe('both\n')
    const failing = { write: () => { throw new Error('closed') } }
    expect(() => { new Console(failing).log('x') }).not.toThrow()
    expect(() => { new Console({ stdout: failing, ignoreErrors: false }).log('x') }).toThrow('closed')
  })

  it('rejects a stream with no write', () => {
    expect(() => new Console({} as never)).toThrow(/stdout/)
  })

  it('prints Trace with the message and the stack beneath it', () => {
    const err = sink()
    new Console({ stdout: sink(), stderr: err }).trace('where %s', 'here')
    const [first, ...frames] = err.text().trimEnd().split('\n')
    expect(first).toBe('Trace: where here')
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((line) => /^\s+at /.test(line))).toBe(true)
  })

  it('times a label with time, timeLog and timeEnd, and warns about a label that is not there', () => {
    const out = sink()
    const console = new Console({ stdout: out })
    console.time('t')
    console.timeLog('t', 'extra', 1)
    console.timeEnd('t')
    const [log, end] = out.text().trimEnd().split('\n')
    expect(log).toMatch(/^t: [\d.]+(ms|s) extra 1$/)
    expect(end).toMatch(/^t: [\d.]+(ms|s)$/)
    const warnings: unknown[] = []
    const emit = globalThis.process.emitWarning
    globalThis.process.emitWarning = ((warning: unknown) => { warnings.push(warning) }) as typeof emit
    try {
      console.timeEnd('t')
      console.countReset('never')
    } finally { globalThis.process.emitWarning = emit }
    expect(warnings).toEqual(["No such label 't' for console.timeEnd()", "Count for 'never' does not exist"])
  })

  // Node before 24 centres the cells of a table; the shim left-aligns them, as later Nodes do, so
  // the grids below are written out instead of compared with the running Node.
  it('draws console.table as a left-aligned grid', () => {
    expect(renderTable([{ a: 1, b: 'xy' }, { a: 22, b: 'z' }])).toBe([
      '┌─────────┬────┬──────┐',
      '│ (index) │ a  │ b    │',
      '├─────────┼────┼──────┤',
      '│ 0       │ 1  │ \'xy\' │',
      '│ 1       │ 22 │ \'z\'  │',
      '└─────────┴────┴──────┘'
    ].join('\n'))
    expect(renderTable([1, 'two'])).toBe([
      '┌─────────┬────────┐',
      '│ (index) │ Values │',
      '├─────────┼────────┤',
      '│ 0       │ 1      │',
      '│ 1       │ \'two\'  │',
      '└─────────┴────────┘'
    ].join('\n'))
    expect(renderTable(new Map([['k', 1]]))).toBe([
      '┌───────────────────┬─────┬────────┐',
      '│ (iteration index) │ Key │ Values │',
      '├───────────────────┼─────┼────────┤',
      '│ 0                 │ \'k\' │ 1      │',
      '└───────────────────┴─────┴────────┘'
    ].join('\n'))
    expect(renderTable({ r: { a: 1 }, s: 5 }, ['a'])).toBe([
      '┌─────────┬───┐',
      '│ (index) │ a │',
      '├─────────┼───┤',
      '│ r       │ 1 │',
      '│ s       │   │',
      '└─────────┴───┘'
    ].join('\n'))
    expect(renderTable('not an object')).toBeUndefined()
  })

  it('console.table prints a primitive as log does, and refuses properties that are not an array', () => {
    const out = sink()
    const console = new Console({ stdout: out })
    console.table('plain')
    expect(out.text()).toBe('plain\n')
    expect(() => { console.table([], 'a' as never) }).toThrow(/properties/)
  })
})
