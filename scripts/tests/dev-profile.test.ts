import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { devSwitches, makeDevProfile, profileInUse, removeDevProfile, removeWhenDone, sweepDevProfiles } from '../dev-profile.mjs'

const fresh = (): string => '/tmp/orivon-dev-profile-abc123'

describe('devSwitches', () => {
  it('starts every launch on a fresh profile', () => {
    expect(devSwitches([], fresh)).toEqual({ switches: ['--user-data-dir=/tmp/orivon-dev-profile-abc123'], profile: '/tmp/orivon-dev-profile-abc123' })
  })

  it('passes the arguments after `npm run dev --` to Electron, but not its own --skip-intro', () => {
    expect(devSwitches(['--skip-intro', '--password-store=basic'], fresh).switches)
      .toEqual(['--user-data-dir=/tmp/orivon-dev-profile-abc123', '--password-store=basic'])
  })

  it('makes no profile when one is named, so nothing it did not make is deleted', () => {
    let made = false
    const result = devSwitches(['--user-data-dir=/home/me/orivon-dev'], () => { made = true; return fresh() })
    expect(result).toEqual({ switches: ['--user-data-dir=/home/me/orivon-dev'], profile: null })
    expect(made).toBe(false)
  })
})

describe('the dev profile on disk', () => {
  const LAUNCHER = 100
  const BROWSER = 200
  const OTHER_PROFILE = 300
  let tmp: string
  let alive: Set<number>
  const isAlive = (pid: number): boolean => alive.has(pid)
  const inUse = (dir: string): boolean => profileInUse(dir, isAlive, LAUNCHER)
  const running = (dir: string, pid: number): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.orivon-running'), JSON.stringify({ pid, bootTime: 0 }))
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dev-profile-test-'))
    alive = new Set([LAUNCHER])
  })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('is made under the temp directory, naming the launch that made it', () => {
    const dir = makeDevProfile(tmp, LAUNCHER)
    expect(basename(dir)).toMatch(/^orivon-dev-profile-[A-Za-z0-9]{6}$/)
    expect(readFileSync(join(dir, '.orivon-dev-launcher'), 'utf8')).toBe(String(LAUNCHER))
  })

  it('is in use while its browser runs, and not once that process is gone', () => {
    const dir = makeDevProfile(tmp, LAUNCHER)
    running(dir, BROWSER)
    alive.add(BROWSER)
    expect(inUse(dir)).toBe(true)
    alive.delete(BROWSER)
    expect(inUse(dir)).toBe(false)
  })

  it('is kept while a profile opened from the launch runs inside it', () => {
    const dir = makeDevProfile(tmp, LAUNCHER)
    running(join(dir, 'profiles', 'p1'), OTHER_PROFILE)
    alive.add(OTHER_PROFILE)
    expect(removeWhenDone(dir, 500, inUse, () => {})).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })

  it('is in use while another launch that made it is still starting', () => {
    const dir = makeDevProfile(tmp, 400)
    alive.add(400)
    expect(inUse(dir)).toBe(true)
  })

  it('is deleted once its browser has quit', () => {
    const dir = makeDevProfile(tmp, LAUNCHER)
    running(dir, BROWSER)
    alive.add(BROWSER)
    let polls = 0
    const quitting = (): void => { if (++polls === 3) alive.delete(BROWSER) }
    expect(removeWhenDone(dir, 10_000, inUse, quitting)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('sweeps what earlier launches left, and only dev profiles', () => {
    const left = makeDevProfile(tmp, 999)
    const busy = makeDevProfile(tmp, 999)
    running(busy, OTHER_PROFILE)
    alive.add(OTHER_PROFILE)
    const unrelated = join(tmp, 'orivon-dev-grant-abc123')
    mkdirSync(unrelated)
    sweepDevProfiles(tmp, inUse)
    expect(existsSync(left)).toBe(false)
    expect(existsSync(busy)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('never throws over a profile that is already gone', () => {
    expect(removeDevProfile(join(tmp, 'orivon-dev-profile-gone00'), inUse)).toBe(true)
  })
})
