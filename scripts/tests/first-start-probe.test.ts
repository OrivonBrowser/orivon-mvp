import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  anyFailed, appVersionOf, browserPid, formatReport, formatTable, numericLeaves, parseArgs, parseStartupRecord, readAsarFile, seriesStats, stats
} from '../first-start-probe.mjs'

describe('parseArgs', () => {
  it('takes the executable and defaults to five runs', () => {
    expect(parseArgs(['/opt/Orivon/orivon'])).toEqual({ executable: '/opt/Orivon/orivon', runs: 5, json: undefined, label: undefined, offline: false, appArgs: [] })
  })

  it('reads the switches in any order and hands everything after -- to the app', () => {
    expect(parseArgs(['--runs', '3', 'orivon', '--json', 'out/probe.json', '--label', 'baseline v0.1.0', '--offline', '--', '--no-sandbox', '--runs', '9'])).toEqual({
      executable: 'orivon', runs: 3, json: 'out/probe.json', label: 'baseline v0.1.0', offline: true, appArgs: ['--no-sandbox', '--runs', '9']
    })
  })

  it('refuses a missing or second executable, an unknown switch, a missing value and runs that are not a count', () => {
    expect(() => parseArgs([])).toThrow('no executable')
    expect(() => parseArgs(['a', 'b'])).toThrow('one executable, not 2')
    expect(() => parseArgs(['a', '--fast'])).toThrow('unknown switch --fast')
    expect(() => parseArgs(['a', '--json'])).toThrow('--json needs a value')
    for (const runs of ['0', '-1', '2.5', 'many', '51']) expect(() => parseArgs(['a', '--runs', runs])).toThrow('--runs takes a whole number from 1 to 50')
  })
})

describe('parseStartupRecord', () => {
  const record = { totalMs: 2400, phases: { ready: 900, window: 1500 } }

  it('reads the app\'s own line out of its other output, with either line ending', () => {
    const output = `some log\n[orivon][startup] ${JSON.stringify(record)}\nmore log`
    expect(parseStartupRecord(output)).toEqual(record)
    expect(parseStartupRecord(output.replaceAll('\n', '\r\n'))).toEqual(record)
  })

  it('is undefined for a build that prints none, a line cut off mid-print, and a line that holds no object', () => {
    expect(parseStartupRecord('DevTools listening on ws://127.0.0.1:1/devtools/browser/x\n')).toBeUndefined()
    expect(parseStartupRecord('[orivon][startup] {"totalMs": 24')).toBeUndefined()
    expect(parseStartupRecord('[orivon][startup] [1,2]\n[orivon][startup] 7\n')).toBeUndefined()
  })

  it('skips a line that is not valid JSON and takes the first that is', () => {
    expect(parseStartupRecord('[orivon][startup] {oops}\n[orivon][startup] {"a":1}\n[orivon][startup] {"a":2}\n')).toEqual({ a: 1 })
  })

  it('does not take a line that merely quotes the tag', () => {
    expect(parseStartupRecord('see [orivon][startup] {"a":1}')).toBeUndefined()
  })
})

describe('numericLeaves', () => {
  it('names each number by its path and leaves out strings, arrays and nulls', () => {
    expect(numericLeaves({ totalMs: 5, phases: { ready: 2, deeper: { x: 1 } }, name: 'a', list: [1, 2], none: null, bad: Number.NaN })).toEqual({ totalMs: 5, 'phases.ready': 2, 'phases.deeper.x': 1 })
  })

  it('is empty for no record', () => {
    expect(numericLeaves(undefined)).toEqual({})
  })
})

describe('stats', () => {
  it('gives the median, minimum and maximum', () => {
    expect(stats([3000, 1000, 2000])).toEqual({ n: 3, median: 2000, min: 1000, max: 3000 })
  })

  it('takes the rounded mean of the two middle values of an even count', () => {
    expect(stats([1, 2, 4, 9]).median).toBe(3)
    expect(stats([1, 2]).median).toBe(2)
  })

  it('has nothing to say about no values', () => {
    expect(stats([])).toEqual({ n: 0, median: undefined, min: undefined, max: undefined })
  })
})

describe('seriesStats', () => {
  it('summarizes the launches that worked, the app\'s record numbers included, and skips a failed one', () => {
    const result = seriesStats([
      { shellMs: 3000, extensionMs: 4000, record: { totalMs: 2500 } },
      { shellMs: 1000, extensionMs: 2000 },
      { error: 'no rendered shell page within 300 s' },
      { shellMs: 2000, extensionMs: 6000, record: { totalMs: 1500 } }
    ])
    expect(result.shellMs).toEqual({ n: 3, median: 2000, min: 1000, max: 3000 })
    expect(result.extensionMs).toEqual({ n: 3, median: 4000, min: 2000, max: 6000 })
    expect(result['startup.totalMs']).toEqual({ n: 2, median: 2000, min: 1500, max: 2500 })
  })

  it('is empty when no launch worked', () => {
    expect(seriesStats([{ error: 'x' }])).toEqual({})
  })
})

const worked = (shellMs: number, extensionMs: number): { shellMs: number, extensionMs: number } => ({ shellMs, extensionMs })
const result = {
  date: '2026-11-20T10:00:00.000Z',
  os: { platform: 'linux', release: '6.1', arch: 'x64' },
  executable: '/opt/Orivon/orivon',
  label: 'current',
  appVersion: '0.1.0',
  runsPerSeries: 2,
  first: { runs: [worked(3000, 5000), worked(3400, 5200)], stats: seriesStats([worked(3000, 5000), worked(3400, 5200)]) },
  next: { warmup: worked(3100, 5100), runs: [worked(1800, 2500), { error: 'the app exited (1) before its shell page rendered' }], stats: seriesStats([worked(1800, 2500)]) }
}

describe('formatTable', () => {
  it('lines up a row per measure with its series named once', () => {
    expect(formatTable([{ title: 'first start', stats: result.first.stats }, { title: 'next start', stats: {} }], 2)).toBe([
      'series       measure                      n  median   min   max',
      '-----------  -------------------------  ---  ------  ----  ----',
      'first start  shell page rendered        2/2    3200  3000  3400',
      '             bundled extension running  2/2    5100  5000  5200',
      'next start   (no launch worked)         0/2       -     -     -'
    ].join('\n'))
  })
})

describe('formatReport', () => {
  it('heads the table with what was timed and names every failed launch', () => {
    const text = formatReport(result)
    expect(text.split('\n')[0]).toBe('current 0.1.0 on linux x64 (ms, 2026-11-20T10:00:00.000Z)')
    expect(text).toContain('first start  shell page rendered        2/2')
    expect(text).toContain('next start   shell page rendered        1/2')
    expect(text.split('\n').at(-1)).toBe('FAILED next start launch 2: the app exited (1) before its shell page rendered')
    expect(text).not.toContain('NOTE')
  })

  it('says when a next-start launch had to be killed, since the launch after it then starts as after a crash', () => {
    const killedOnce = { ...result, next: { ...result.next, warmup: { ...worked(3100, 5100), ended: 'killed' } } }
    expect(formatReport(killedOnce)).toContain('NOTE next start: 1 launch(es) did not quit when asked and were killed')
  })
})

describe('anyFailed', () => {
  it('sees a failed launch or warm-up and nothing else', () => {
    expect(anyFailed(result)).toBe(true)
    expect(anyFailed({ first: { runs: [worked(1, 2)] }, next: { warmup: worked(1, 2), runs: [worked(1, 2)] } })).toBe(false)
    expect(anyFailed({ first: { runs: [] }, next: { warmup: { error: 'x' }, runs: [] } })).toBe(true)
  })
})

describe('the version of a package', () => {
  const folders: string[] = []
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

  /** An asar archive as electron's own tool writes it: two size words, the header's JSON in a pickle, then the files. */
  const asar = (files: Record<string, string>): Buffer => {
    let offset = 0
    const tree: Record<string, { size: number, offset: string }> = {}
    for (const [name, text] of Object.entries(files)) {
      tree[name] = { size: Buffer.byteLength(text), offset: String(offset) }
      offset += Buffer.byteLength(text)
    }
    const json = Buffer.from(JSON.stringify({ files: tree }))
    const padded = (4 + json.length + 3) & ~3
    const head = Buffer.alloc(16 + padded - 4)
    head.writeUInt32LE(4, 0)
    head.writeUInt32LE(padded + 4, 4)
    head.writeUInt32LE(padded, 8)
    head.writeUInt32LE(json.length, 12)
    json.copy(head, 16)
    return Buffer.concat([head, ...Object.values(files).map((text) => Buffer.from(text))])
  }

  const packageAt = (...parts: string[]): string => {
    const root = mkdtempSync(join(tmpdir(), 'probe-asar-'))
    folders.push(root)
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true })
    return join(root, ...parts)
  }

  it('reads one file of an archive, and nothing from a missing archive or file', () => {
    const file = packageAt('app.asar')
    writeFileSync(file, asar({ 'package.json': '{"version":"0.1.0"}', other: 'xyz' }))
    expect(readAsarFile(file, 'package.json')?.toString()).toBe('{"version":"0.1.0"}')
    expect(readAsarFile(file, 'other')?.toString()).toBe('xyz')
    expect(readAsarFile(file, 'absent')).toBeUndefined()
    expect(readAsarFile(join(file, '..', 'gone.asar'), 'package.json')).toBeUndefined()
  })

  it('finds the version beside a Linux or Windows executable and inside a macOS app, and has none for an AppImage', () => {
    const linux = packageAt('opt', 'resources', 'app.asar')
    writeFileSync(linux, asar({ 'package.json': '{"version":"0.2.0"}' }))
    expect(appVersionOf(join(linux, '..', '..', 'orivon'))).toBe('0.2.0')
    const mac = packageAt('Orivon.app', 'Contents', 'Resources', 'app.asar')
    writeFileSync(mac, asar({ 'package.json': '{"version":"0.3.0"}' }))
    expect(appVersionOf(join(mac, '..', '..', 'MacOS', 'Orivon'))).toBe('0.3.0')
    expect(appVersionOf(join(packageAt('Orivon.AppImage'), '..', 'Orivon.AppImage'))).toBeUndefined()
  })
})

describe('browserPid', () => {
  const table = [
    { pid: 100, ppid: 1, args: 'bash /home/a/.local/lib/orivon/orivon --user-data-dir=/tmp/p' },
    { pid: 101, ppid: 100, args: '/home/a/.local/lib/orivon/Orivon.AppImage --appimage-extract-and-run' },
    { pid: 102, ppid: 101, args: '/tmp/appimage_extracted_x/orivon --user-data-dir=/tmp/p' },
    { pid: 103, ppid: 102, args: '/tmp/appimage_extracted_x/orivon --type=zygote' },
    { pid: 104, ppid: 103, args: '/tmp/appimage_extracted_x/orivon --type=renderer' },
    { pid: 199, ppid: 1, args: '/opt/Other/other' },
    { pid: 200, ppid: 199, args: '/opt/Other/other --type=gpu-process' }
  ]

  it('finds Electron behind a launcher and the AppImage runtime, and never another program\'s browser', () => {
    expect(browserPid(100, table)).toBe(102)
  })

  it('is the launched process itself when no helper of its own runs', () => {
    expect(browserPid(100, table.filter((entry) => entry.pid < 103))).toBe(100)
    expect(browserPid(300, table)).toBe(300)
  })
})
