import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiagnosticsService, LOG_GONE_LINE } from '../diagnostics-service.js'
import type { ServiceEnv } from '../diagnostics-service.js'

let root: string
let clock: number
let counter: number

const env = (overrides: Partial<ServiceEnv> = {}): ServiceEnv => ({
  dir: join(root, 'diagnostics'),
  crashDumpsDir: join(root, 'Crashpad'),
  isPrivate: false,
  now: () => clock,
  randomBytes: () => { counter += 1; return Uint8Array.from([counter, 0, 0, 0, 0, 0, 0, 0]) },
  pid: 42,
  ...overrides
})

function dump (name: string, atMs: number): void {
  mkdirSync(join(root, 'Crashpad', 'pending'), { recursive: true })
  const path = join(root, 'Crashpad', 'pending', name)
  writeFileSync(path, 'dmp')
  utimesSync(path, atMs / 1000, atMs / 1000)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orivon-service-'))
  clock = Date.parse('2026-10-07T10:00:00Z')
  counter = 0
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('a run that ends in an orderly quit', () => {
  it('leaves nothing for the next start to find', () => {
    const first = new DiagnosticsService(env())
    first.begin()
    first.end()
    const second = new DiagnosticsService(env())
    second.begin()
    expect(second.crashes()).toEqual([])
    expect(second.lastRunCrash()).toBeUndefined()
  })
})

describe('a run that does not', () => {
  it('is found at the next start as an unclean exit the person may report', () => {
    new DiagnosticsService(env()).begin()
    clock += 3_600_000
    const second = new DiagnosticsService(env())
    second.begin()
    expect(second.crashes()).toHaveLength(1)
    expect(second.lastRunCrash()).toMatchObject({ kind: 'unclean-exit', at: '2026-10-07T10:00:00Z' })
  })

  it('is the same event as the fatal error it left, not a second record', () => {
    const first = new DiagnosticsService(env())
    first.begin()
    first.recordFatal('uncaught exception', new Error('boom'))
    clock += 1000
    const second = new DiagnosticsService(env())
    second.begin()
    expect(second.crashes().map((record) => record.kind)).toEqual(['main-error'])
    expect(second.lastRunCrash()).toMatchObject({ kind: 'main-error', reason: 'uncaught exception', message: 'boom', process: 'main' })
  })

  it('takes the time of a native dump the run left, which then belongs to the record', () => {
    new DiagnosticsService(env()).begin()
    const crashAt = clock + 600_000
    dump('a.dmp', crashAt)
    clock += 3_600_000
    const second = new DiagnosticsService(env())
    second.begin()
    const record = second.lastRunCrash()
    expect(record).toMatchObject({ kind: 'unclean-exit', at: '2026-10-07T10:10:00Z', reason: 'crashed' })
    expect(second.dumpOf(record as never)?.path.endsWith('a.dmp')).toBe(true)
  })

  it('does not take the dump of a crash the run recorded for its own: the exit has none, and starts when the run did', () => {
    const first = new DiagnosticsService(env())
    first.begin()
    clock += 600_000
    dump('renderer.dmp', clock)
    const renderer = first.record({ kind: 'renderer', process: 'tab', reason: 'crashed', exitCode: 1, message: '', stack: '' })
    clock += 3_000_000
    const second = new DiagnosticsService(env())
    second.begin()
    const exit = second.lastRunCrash()
    expect(exit).toMatchObject({ kind: 'unclean-exit', reason: 'abnormal-exit', at: '2026-10-07T10:00:00Z' })
    expect(second.dumpOf(exit as never)).toBeUndefined()
    expect(second.dumpOf(renderer)?.path.endsWith('renderer.dmp')).toBe(true)
  })

  it('does not match a dump an earlier run left to a later run that ended with none of its own', () => {
    new DiagnosticsService(env()).begin()
    dump('first-run.dmp', clock + 20_000)
    clock += 30_000
    const second = new DiagnosticsService(env())
    second.begin()
    expect(second.dumpOf(second.lastRunCrash() as never)?.path.endsWith('first-run.dmp')).toBe(true)
    second.markReported(second.lastRunCrash()?.id as string, 'b'.repeat(32))
    clock += 120_000
    const third = new DiagnosticsService(env())
    third.begin()
    const exit = third.lastRunCrash()
    expect(exit).toMatchObject({ reason: 'abnormal-exit', at: '2026-10-07T10:00:30Z' })
    expect(third.dumpOf(exit as never)).toBeUndefined()
  })

  it('does not offer a crash that was already reported', () => {
    new DiagnosticsService(env()).begin()
    const second = new DiagnosticsService(env())
    second.begin()
    const id = second.lastRunCrash()?.id as string
    second.markReported(id, 'a'.repeat(32))
    second.end()
    const third = new DiagnosticsService(env())
    third.begin()
    expect(third.lastRunCrash()).toBeUndefined()
  })
})

describe('records', () => {
  it('writes a fatal record to disk before returning, so the process can exit after it', () => {
    const service = new DiagnosticsService(env())
    service.begin()
    service.recordFatal('unhandled promise rejection', 'plain text')
    const onDisk = JSON.parse(readFileSync(join(root, 'diagnostics', 'crashes.json'), 'utf8')) as Array<{ kind: string, reason: string }>
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0]).toMatchObject({ kind: 'main-error', reason: 'unhandled promise rejection' })
  })

  it('keeps only the first fatal error of a run: what throws while the process exits is its fallout', () => {
    const service = new DiagnosticsService(env())
    service.begin()
    const first = service.recordFatal('uncaught exception', new Error('the cause'))
    expect(service.recordFatal('uncaught exception', new Error('Object has been destroyed'))).toBe(first)
    expect(service.crashes().map((record) => record.message)).toEqual(['the cause'])
  })

  it('finds a page\'s crash by its web contents in this run only', () => {
    const service = new DiagnosticsService(env())
    service.begin()
    const record = service.record({ kind: 'renderer', process: 'tab', reason: 'crashed', exitCode: 1, message: '', stack: '', page: 'https://x.org/', webContentsId: 7 })
    expect(service.crashOfPage(7)?.id).toBe(record.id)
    expect(service.crashOfPage(8)).toBeUndefined()
  })

  it('keeps the crashed page\'s address, except in a private session', () => {
    const open = new DiagnosticsService(env())
    open.begin()
    expect(open.record({ kind: 'renderer', process: 'tab', reason: 'crashed', exitCode: 1, message: '', stack: '', page: 'https://x.org/' }).page).toBe('https://x.org/')
    const priv = new DiagnosticsService(env({ dir: join(root, 'private'), isPrivate: true }))
    priv.begin()
    const record = priv.record({ kind: 'renderer', process: 'tab', reason: 'crashed', exitCode: 1, message: '', stack: '', page: 'https://x.org/' })
    expect(record).not.toHaveProperty('page')
    expect(readFileSync(join(root, 'private', 'crashes.json'), 'utf8')).not.toContain('x.org')
  })

  it('cuts a record\'s text to the report limits', () => {
    const service = new DiagnosticsService(env())
    service.begin()
    const record = service.record({ kind: 'main-error', process: '', reason: 'r'.repeat(500), exitCode: null, message: 'm'.repeat(9000), stack: 's'.repeat(90_000) })
    expect(record.process).toBe('unknown')
    expect(record.reason).toHaveLength(64)
    expect(record.message).toHaveLength(2000)
    expect(record.stack).toHaveLength(20_000)
  })
})

describe('the log of a report', () => {
  it('is the previous run\'s own file for a crash of that run, and this run\'s ring for anything else', () => {
    const first = new DiagnosticsService(env())
    first.begin()
    first.log('error', 'died here')
    const fatal = first.recordFatal('uncaught exception', new Error('boom'))
    const second = new DiagnosticsService(env())
    second.begin()
    second.log('log', 'this run')
    expect(second.logLines(fatal).some((line) => line.includes('died here'))).toBe(true)
    expect(second.logLines(fatal).some((line) => line.includes('this run'))).toBe(false)
    expect(second.logLines().some((line) => line.includes('this run'))).toBe(true)
    expect(second.logLines(second.record({ kind: 'renderer', process: 'tab', reason: 'crashed', exitCode: 1, message: '', stack: '' })).some((line) => line.includes('this run'))).toBe(true)
  })
})

describe('the log of an older crash', () => {
  const crashIn = (service: DiagnosticsService) => service.record({ kind: 'renderer', process: 'tab', reason: 'crashed', exitCode: 1, message: '', stack: '' })

  it('is the previous run\'s file after an orderly quit too, since the file says which run wrote it', () => {
    const first = new DiagnosticsService(env())
    first.begin()
    first.log('error', 'first run line')
    const crash = crashIn(first)
    first.end()
    const second = new DiagnosticsService(env())
    second.begin()
    second.log('log', 'second run line')
    const lines = second.logLines(crash)
    expect(lines[0]).toContain(first.sessionId)
    expect(lines.some((line) => line.includes('first run line'))).toBe(true)
    expect(lines.some((line) => line.includes('second run line'))).toBe(false)
  })

  it('is one line saying it is gone when the run is older than the previous one, and never another run\'s', () => {
    const first = new DiagnosticsService(env())
    first.begin()
    const crash = crashIn(first)
    first.end()
    const second = new DiagnosticsService(env())
    second.begin()
    second.log('log', 'second run line')
    second.end()
    const third = new DiagnosticsService(env())
    third.begin()
    expect(third.logLines(crash)).toEqual([LOG_GONE_LINE])
    expect(third.logSourceOf(crash)).toBe('none')
  })

  it('says which run the current log is in its file, and keeps that out of the ring', () => {
    const service = new DiagnosticsService(env())
    service.log('log', 'hello')
    service.end()
    expect(readFileSync(join(root, 'diagnostics', 'logs', 'current.log'), 'utf8').split('\n')[0]).toContain(service.sessionId)
    expect(service.logLines().some((line) => line.includes(service.sessionId))).toBe(false)
  })
})

describe('the log', () => {
  it('keeps lines in the ring and writes them to current.log on a flush', () => {
    const service = new DiagnosticsService(env())
    service.log('error', 'something broke')
    service.end()
    expect(service.logLines()[0]).toContain('ERROR something broke')
    expect(readFileSync(join(root, 'diagnostics', 'logs', 'current.log'), 'utf8')).toContain('ERROR something broke')
  })
})
