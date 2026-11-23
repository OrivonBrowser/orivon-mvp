import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STARTUP_PROFILE_ENV } from '../startup-profile.js'

/** The runner starts the profile when it is evaluated, so each test evaluates a fresh one under the environment it sets. */
async function freshRunner (): Promise<typeof import('../startup-profile-runner.js')> {
  vi.resetModules()
  return await import('../startup-profile-runner.js')
}

describe('the start-up profile on the real inspector', () => {
  let folder: string
  let printed: string[]

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'orivon-startup-profile-'))
    printed = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { printed.push(String(line)) })
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { printed.push(String(line)) })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(folder, { recursive: true, force: true })
  })

  it('writes a profile in the DevTools format, with where it began, when the variable names a file', async () => {
    const file = join(folder, 'deep', 'er', 'start.cpuprofile')
    vi.stubEnv(STARTUP_PROFILE_ENV, file)
    const runner = await freshRunner()
    // Something to sample: the profile must show the work done between its start and its stop.
    const spin = Date.now() + 40
    let sum = 0
    while (Date.now() < spin) sum += Math.sqrt(sum + 1)
    runner.stopStartupProfile('the test')
    const profile = JSON.parse(readFileSync(file, 'utf8')) as { nodes: Array<{ id: number, callFrame: { functionName: string } }>, samples: number[], timeDeltas: number[], startTime: number, endTime: number, orivon: Record<string, unknown> }
    expect(profile.nodes.length).toBeGreaterThan(1)
    expect(profile.samples.length).toBeGreaterThan(10)
    expect(profile.timeDeltas).toHaveLength(profile.samples.length)
    expect(profile.endTime).toBeGreaterThan(profile.startTime)
    expect(profile.orivon).toMatchObject({ schema: 1, stoppedBecause: 'the test', base: 'performance-origin' })
    expect(printed.filter((line) => line.includes('[orivon][startup-profile] wrote'))).toHaveLength(1)
    expect(readdirSync(join(folder, 'deep', 'er'))).toEqual(['start.cpuprofile'])
  })

  it('does nothing with the variable unset: no inspector, no file, no line', async () => {
    vi.stubEnv(STARTUP_PROFILE_ENV, '')
    const runner = await freshRunner()
    runner.stopStartupProfile('the test')
    expect(printed).toEqual([])
    expect(existsSync(join(folder, 'start.cpuprofile'))).toBe(false)
    expect(readdirSync(folder)).toEqual([])
  })

  it('is one warning and no profile when the file cannot be made, and never throws', async () => {
    vi.stubEnv(STARTUP_PROFILE_ENV, join(folder, 'start.cpuprofile', 'inside-a-file'))
    // A file where a folder is needed.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(folder, 'start.cpuprofile'), 'a file, not a folder')
    const runner = await freshRunner()
    expect(() => { runner.stopStartupProfile('the test') }).not.toThrow()
    expect(printed.filter((line) => line.includes('[orivon][startup-profile]'))).toHaveLength(1)
    expect(printed[0]).toContain('writing the profile failed')
    expect(readdirSync(folder)).toEqual(['start.cpuprofile'])
  })
})
