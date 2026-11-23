import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatSummary, groupOf, parseArgs, shortPath, summarizeProfile } from '../startup-profile-summary.mjs'

const APP = 'file:///opt/Orivon/resources/app.asar/out/main/index.js'

/**
 * Nine samples a millisecond apart, the profile one millisecond longer than the last. The sample at index i is at 101 + i ms
 * on the start-up line's clock (the profile began at 100):
 *   i: 0 app, 1 and 2 loadStores, 3 and 4 readFile (called by loadStores), 5 to 7 idle, 8 loadStores
 */
function tinyProfile (anchor: object | null = { schema: 1, startMs: 100, base: 'process-creation', stoppedBecause: 'the start-up line printed' }): Record<string, unknown> {
  const frame = (functionName: string, url: string, lineNumber: number): object => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' })
  return {
    nodes: [
      { id: 1, callFrame: frame('(root)', '', -1), children: [2, 4] },
      { id: 2, callFrame: frame('boot', APP, 9), children: [3] },
      { id: 3, callFrame: frame('loadStores', APP, 19), children: [5] },
      { id: 4, callFrame: frame('(idle)', '', -1) },
      { id: 5, callFrame: frame('readFile', 'node:internal/fs/promises', 4) }
    ],
    startTime: 1_000_000,
    endTime: 1_010_000,
    samples: [2, 3, 3, 5, 5, 4, 4, 4, 3],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
    ...(anchor === null ? {} : { orivon: anchor })
  }
}

const byName = (list: Array<{ name: string }>, name: string): Record<string, number> | undefined => list.find((fn) => fn.name === name) as unknown as Record<string, number> | undefined

describe('summarizeProfile', () => {
  it('adds up the time each function ran itself and the time it was on the stack, over the whole profile', () => {
    const summary = summarizeProfile(tinyProfile())
    expect(summary.samples).toBe(9)
    expect(summary.totalMs).toBeCloseTo(9)
    expect(byName(summary.bySelf, 'boot')?.selfMs).toBeCloseTo(1)
    expect(byName(summary.bySelf, 'loadStores')?.selfMs).toBeCloseTo(3)
    expect(byName(summary.bySelf, 'readFile')?.selfMs).toBeCloseTo(2)
    expect(summary.idleMs).toBeCloseTo(3)
    expect(summary.bySelf.map(({ name }) => name)).toEqual(['loadStores', '(idle)', 'readFile', 'boot'])
    expect(byName(summary.byTotal, 'boot')?.totalMs).toBeCloseTo(6)
    expect(byName(summary.byTotal, 'loadStores')?.totalMs).toBeCloseTo(5)
    expect(byName(summary.byTotal, 'readFile')?.totalMs).toBeCloseTo(2)
    expect(summary.bySelf.some(({ name }) => name === '(root)')).toBe(false)
  })

  it('reads a window on the start-up line\'s clock when the profile says where it began', () => {
    const summary = summarizeProfile(tinyProfile(), { fromMs: 103, toMs: 107 })
    expect(summary.anchored).toBe(true)
    expect(summary.samples).toBe(4)
    expect(summary.totalMs).toBeCloseTo(4)
    expect(byName(summary.bySelf, 'readFile')?.selfMs).toBeCloseTo(2)
    expect(byName(summary.bySelf, 'loadStores')?.selfMs).toBeCloseTo(1)
    expect(byName(summary.bySelf, 'boot')).toBeUndefined()
    expect(summary.byGroup.map(({ group }) => group)).toEqual(['node:internal', 'out/main/index.js', '(idle)'])
  })

  it('counts from the profile\'s own start when it has no anchor', () => {
    const summary = summarizeProfile(tinyProfile(null), { fromMs: 4, toMs: 6 })
    expect(summary.anchored).toBe(false)
    expect(summary.samples).toBe(2)
    expect(byName(summary.bySelf, 'readFile')?.selfMs).toBeCloseTo(2)
  })

  it('counts a function that calls itself once per sample', () => {
    const frame = { functionName: 'walk', url: APP, lineNumber: 1, columnNumber: 0, scriptId: '1' }
    const summary = summarizeProfile({
      nodes: [{ id: 1, callFrame: { ...frame, functionName: '(root)', url: '' }, children: [2] }, { id: 2, callFrame: frame, children: [3] }, { id: 3, callFrame: frame }],
      startTime: 0, endTime: 4000, samples: [3, 3], timeDeltas: [1000, 1000]
    })
    expect(byName(summary.byTotal, 'walk')?.totalMs).toBeCloseTo(summary.totalMs)
  })

  it('is empty for a window outside the profile', () => {
    const summary = summarizeProfile(tinyProfile(), { fromMs: 5000, toMs: 6000 })
    expect(summary.samples).toBe(0)
    expect(summary.bySelf).toEqual([])
  })
})

describe('formatSummary', () => {
  it('names the window, how much of it was idle, and the functions with their file and line', () => {
    const text = formatSummary(summarizeProfile(tinyProfile(), { fromMs: 101, toMs: 110 }), { file: 'start.cpuprofile', top: 3 })
    expect(text).toContain('start.cpuprofile: 10.0 ms profiled, stopped because the start-up line printed')
    expect(text).toContain('window: 101.0 to 110.0 ms on the start-up line\'s clock (since the process was created)')
    expect(text).toContain('idle 3.0 ms (33.3%)')
    expect(text).toMatch(/3\.0 +33\.3 +loadStores +out\/main\/index\.js:20/)
    expect(text).toMatch(/readFile +node:internal\/fs\/promises:5/)
    expect(text).toContain('Self time by file or package')
  })

  it('leaves Node\'s module loader frames out of the total-time table, where every require would head it', () => {
    const frame = (functionName: string, url: string, lineNumber: number): object => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' })
    const profile = {
      nodes: [
        { id: 1, callFrame: frame('(root)', '', -1), children: [2] },
        { id: 2, callFrame: frame('wrapModuleLoad', 'node:internal/modules/cjs/loader', 250), children: [3] },
        { id: 3, callFrame: frame('loadStores', APP, 19) }
      ],
      startTime: 0, endTime: 3000, samples: [3, 3], timeDeltas: [1000, 1000]
    }
    const text = formatSummary(summarizeProfile(profile))
    const totals = text.slice(text.indexOf('Total time'), text.indexOf('Self time by file'))
    expect(totals).toContain('loadStores')
    expect(totals).not.toContain('wrapModuleLoad')
    expect(text.slice(0, text.indexOf('Total time'))).not.toContain('wrapModuleLoad')
  })

  it('says so when the profile has no anchor', () => {
    expect(formatSummary(summarizeProfile(tinyProfile(null)))).toContain('it carries no start-up line anchor')
  })
})

describe('groupOf and shortPath', () => {
  it('groups by package, Node, Electron or the app\'s own file, and keeps the names V8 gives non-functions', () => {
    expect(groupOf('(idle)', '')).toBe('(idle)')
    expect(groupOf('x', '')).toBe('(native)')
    expect(groupOf('x', 'node:internal/modules/cjs/loader')).toBe('node:internal')
    expect(groupOf('x', 'node:fs')).toBe('node:fs')
    expect(groupOf('x', 'electron/js2c/browser_init')).toBe('electron:js2c')
    expect(groupOf('x', 'node:electron/js2c/browser_init')).toBe('electron:js2c')
    expect(groupOf('x', 'file:///opt/Orivon/resources/app.asar/node_modules/@scope/pkg/lib/a.js')).toBe('node_modules/@scope/pkg')
    expect(groupOf('x', 'file:///C:/Users/me/AppData/Local/Programs/Orivon/resources/app.asar/node_modules/zod/index.js')).toBe('node_modules/zod')
    expect(groupOf('x', APP)).toBe('out/main/index.js')
  })

  it('shortens a path to the part inside the app archive, or its last three folders', () => {
    expect(shortPath(APP)).toBe('out/main/index.js')
    expect(shortPath('file:///C:/Users/me/App%20Data/Orivon/resources/app.asar/out/main/chunks/a.js')).toBe('out/main/chunks/a.js')
    expect(shortPath('file:///home/me/work/orivon/out/main/index.js')).toBe('.../out/main/index.js')
    expect(shortPath('')).toBe('')
    expect(shortPath('node:internal/modules/cjs/loader')).toBe('node:internal/modules/cjs/loader')
  })
})

describe('parseArgs', () => {
  it('takes the profile, a window and a count', () => {
    expect(parseArgs(['p.cpuprofile'])).toEqual({ file: 'p.cpuprofile', fromMs: undefined, toMs: undefined, top: 15 })
    expect(parseArgs(['--top', '5', 'p.cpuprofile', '--from-ms', '1200', '--to-ms', '1800.5'])).toEqual({ file: 'p.cpuprofile', fromMs: 1200, toMs: 1800.5, top: 5 })
  })

  it('refuses no profile, two, an unknown switch, a value that is not a number and a window that ends before it starts', () => {
    expect(() => parseArgs([])).toThrow('no profile')
    expect(() => parseArgs(['a', 'b'])).toThrow('one profile, not 2')
    expect(() => parseArgs(['a', '--fast'])).toThrow('unknown switch --fast')
    expect(() => parseArgs(['a', '--from-ms'])).toThrow('--from-ms takes a number')
    expect(() => parseArgs(['a', '--to-ms', 'soon'])).toThrow('--to-ms takes a number, not soon')
    expect(() => parseArgs(['a', '--from-ms', '9', '--to-ms', '9'])).toThrow('not after')
  })
})

describe('the command', () => {
  const folders: string[] = []
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
  const run = (...args: string[]): { status: number | null, stdout: string, stderr: string } => spawnSync(process.execPath, ['scripts/startup-profile-summary.mjs', ...args], { encoding: 'utf8' })

  it('prints the summary of a profile file and of a window of it', () => {
    const folder = mkdtempSync(join(tmpdir(), 'profile-summary-'))
    folders.push(folder)
    const file = join(folder, 'start.cpuprofile')
    writeFileSync(file, JSON.stringify(tinyProfile()))
    const whole = run(file)
    expect(whole.status).toBe(0)
    expect(whole.stdout).toContain('loadStores')
    const window = run(file, '--from-ms', '103', '--to-ms', '107', '--top', '2')
    expect(window.status).toBe(0)
    expect(window.stdout).toContain('window: 103.0 to 107.0')
  })

  it('fails with a line for a missing file, something that is not a profile, and a bad switch', () => {
    const folder = mkdtempSync(join(tmpdir(), 'profile-summary-'))
    folders.push(folder)
    const notProfile = join(folder, 'other.json')
    writeFileSync(notProfile, '{"a":1}')
    expect(run(join(folder, 'absent.cpuprofile')).status).toBe(1)
    const bad = run(notProfile)
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('not a .cpuprofile')
    expect(run('--nope').status).toBe(2)
  })
})
