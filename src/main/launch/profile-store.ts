// The profiles: each is a directory with a `profile.json` in it, so there is no
// shared file for two running browsers to write over each other. The default
// profile is the app's own data directory, so the browser a person already has
// stays where it is; the others sit in `profiles/` inside it. A running profile
// leaves a marker with its process id, so one that is in use is never deleted.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { uptime } from 'node:os'
import { DEFAULT_PROFILE_ID, PROFILE_ID } from './launch-context.js'
import { copyPublicSeed } from './public-seed.js'
import { bootTimeMs, isPidRecordAlive, processIsAlive } from './pid-liveness.js'

const DELETING_PREFIX = '.deleting-'

export const PROFILE_COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'pink', 'teal', 'gray'] as const
export type ProfileColor = (typeof PROFILE_COLORS)[number]

export const MAX_NAME_LENGTH = 40
const FILE_VERSION = 1
const PROFILE_FILE = 'profile.json'
const RUNNING_FILE = '.orivon-running'

export interface Profile {
  readonly id: string
  readonly name: string
  readonly color: ProfileColor
  readonly created: number
}

export const isProfileColor = (value: unknown): value is ProfileColor => typeof value === 'string' && (PROFILE_COLORS as readonly string[]).includes(value)

/** A name a person may give a profile: text, trimmed, not empty, not long, with nothing that draws as control. */
export function cleanName (value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  // eslint-disable-next-line no-control-regex
  return trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null
}

export type Outcome = { readonly ok: true } | { readonly ok: false, readonly reason: 'invalid-name' | 'invalid-color' | 'unknown-profile' | 'default-profile' | 'running' | 'failed' }

const DEFAULT_LOOK: { name: string, color: ProfileColor } = { name: 'Default', color: 'blue' }

export class ProfileStore {
  constructor (
    /** The default profile's directory. */
    private readonly home: string,
    private readonly now: () => number = Date.now,
    private readonly isAlive: (pid: number) => boolean = processIsAlive,
    private readonly uptimeSec: () => number = uptime
  ) {}

  /** The directory of a profile, or null for an id that could not be one: no path is built from anything else. */
  dirOf (id: string): string | null {
    if (id === DEFAULT_PROFILE_ID) return this.home
    return PROFILE_ID.test(id) ? join(this.home, 'profiles', id) : null
  }

  read (id: string): Profile | null {
    const dir = this.dirOf(id)
    if (dir === null) return null
    let stored: Partial<Profile> = {}
    try {
      stored = JSON.parse(readFileSync(join(dir, PROFILE_FILE), 'utf8')) as Partial<Profile>
    } catch {
      // No file (the default profile before it is renamed) or a damaged one: what a profile with none looks like.
      if (id !== DEFAULT_PROFILE_ID && !existsSync(dir)) return null
    }
    const name = cleanName(stored.name) ?? (id === DEFAULT_PROFILE_ID ? DEFAULT_LOOK.name : 'Profile')
    const color = isProfileColor(stored.color) ? stored.color : DEFAULT_LOOK.color
    return { id, name, color, created: typeof stored.created === 'number' ? stored.created : 0 }
  }

  /** The default profile first, then the rest as they were made. */
  list (): Profile[] {
    const others: Profile[] = []
    try {
      for (const entry of readdirSync(join(this.home, 'profiles'), { withFileTypes: true })) {
        if (!entry.isDirectory() || !PROFILE_ID.test(entry.name) || !existsSync(join(this.home, 'profiles', entry.name, PROFILE_FILE))) continue
        const profile = this.read(entry.name)
        if (profile !== null) others.push(profile)
      }
    } catch {
      // No profiles directory yet.
    }
    others.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
    return [this.read(DEFAULT_PROFILE_ID) as Profile, ...others]
  }

  /** Makes a profile. `seeded` gives it the public seed (./public-seed.ts). */
  create (name: unknown, color: unknown, seeded = false): { ok: true, profile: Profile } | Extract<Outcome, { ok: false }> {
    const clean = cleanName(name)
    if (clean === null) return { ok: false, reason: 'invalid-name' }
    if (!isProfileColor(color)) return { ok: false, reason: 'invalid-color' }
    const id = randomBytes(6).toString('hex')
    const dir = this.dirOf(id) as string
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (seeded) copyPublicSeed(this.home, dir)
      const profile: Profile = { id, name: clean, color, created: this.now() }
      this.write(dir, profile)
      return { ok: true, profile }
    } catch {
      rmSync(dir, { recursive: true, force: true })
      return { ok: false, reason: 'failed' }
    }
  }

  rename (id: string, name: unknown): Outcome {
    const clean = cleanName(name)
    if (clean === null) return { ok: false, reason: 'invalid-name' }
    return this.change(id, (profile) => ({ ...profile, name: clean }))
  }

  setColor (id: string, color: unknown): Outcome {
    if (!isProfileColor(color)) return { ok: false, reason: 'invalid-color' }
    return this.change(id, (profile) => ({ ...profile, color }))
  }

  /** Deletes a profile and everything in it. Never the default, and never one that is running. */
  remove (id: string): Outcome {
    if (id === DEFAULT_PROFILE_ID) return { ok: false, reason: 'default-profile' }
    const dir = this.dirOf(id)
    if (dir === null || !existsSync(dir)) return { ok: false, reason: 'unknown-profile' }
    if (this.isRunning(id)) return { ok: false, reason: 'running' }
    // Renamed first: a browser started for it in the meantime finds nothing, not a directory half gone.
    const doomed = join(this.home, 'profiles', `${DELETING_PREFIX}${id}`)
    try {
      renameSync(dir, doomed)
      rmSync(doomed, { recursive: true, force: true })
      return { ok: true }
    } catch {
      return { ok: false, reason: 'failed' }
    }
  }

  /** Removes what a deletion that failed part way left behind: the data of a profile that is gone. */
  sweepDeleted (): void {
    try {
      for (const entry of readdirSync(join(this.home, 'profiles'), { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith(DELETING_PREFIX)) rmSync(join(this.home, 'profiles', entry.name), { recursive: true, force: true })
      }
    } catch {
      // No profiles directory, or a file still open: the next start tries again.
    }
  }

  isRunning (id: string): boolean {
    const dir = this.dirOf(id)
    if (dir === null) return false
    try {
      const marker = JSON.parse(readFileSync(join(dir, RUNNING_FILE), 'utf8')) as { pid?: unknown, bootTime?: unknown }
      if (typeof marker.pid !== 'number') return false
      const record = typeof marker.bootTime === 'number' ? { pid: marker.pid, bootTime: marker.bootTime } : { pid: marker.pid }
      return isPidRecordAlive(record, this.isAlive, this.now(), this.uptimeSec())
    } catch {
      return false
    }
  }

  /** This process is using the profile: written at start, removed at quit. A marker left by a crash
   * names a process that is gone, or one the OS has since reused the pid for (pid-liveness.ts). */
  markRunning (id: string, pid: number): void {
    const dir = this.dirOf(id)
    if (dir === null) return
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, RUNNING_FILE), JSON.stringify({ pid, bootTime: bootTimeMs(this.now(), this.uptimeSec()) }))
    } catch {
      // Not being able to say so must not stop the browser starting.
    }
  }

  clearRunning (id: string): void {
    const dir = this.dirOf(id)
    if (dir !== null) rmSync(join(dir, RUNNING_FILE), { force: true })
  }

  private change (id: string, edit: (profile: Profile) => Profile): Outcome {
    const dir = this.dirOf(id)
    const profile = dir === null ? null : this.read(id)
    if (dir === null || profile === null) return { ok: false, reason: 'unknown-profile' }
    try {
      this.write(dir, edit(profile))
      return { ok: true }
    } catch {
      return { ok: false, reason: 'failed' }
    }
  }

  private write (dir: string, profile: Profile): void {
    writeFileSync(join(dir, PROFILE_FILE), JSON.stringify({ version: FILE_VERSION, name: profile.name, color: profile.color, created: profile.created }, null, 2))
  }
}
