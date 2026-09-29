// A private session's directory: made fresh, holding a copy of the preferences (settings and
// keyboard shortcuts) it began with and nothing else, and removed when the session is over. Deleting it
// is never claimed to happen inside the dying process: Chromium writes after quit
// and Windows will not delete a file that is open. The browser that opened the
// session removes it when the process exits, and the next start of any browser
// sweeps what a crash left.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { copyPublicSeed } from './public-seed.js'
import { bootTimeMs, isPidRecordAlive, processIsAlive } from './pid-liveness.js'
import type { PidRecord } from './pid-liveness.js'

export const PRIVATE_PREFIX = 'orivon-private-'
const MARKER = '.orivon-private.json'
/** mkdtemp's suffix: six characters. */
const NAME = new RegExp(`^${PRIVATE_PREFIX}[A-Za-z0-9]{6}$`)
/** A directory with no marker yet may be one whose process has not written it. */
export const GRACE_MS = 10 * 60 * 1000

/** What a private session starts with, copied from the profile that opened it: its settings and
 * keyboard shortcuts -- both preferences -- plus the public seed (./public-seed.ts). Never
 * history, bookmarks, grants, apps, identity, site data, or zoom.json: a list of sites visited,
 * not a preference. */
export const SNAPSHOT_FILES = ['settings.json', 'shortcuts.json'] as const

/** Makes the directory. `from` is the opening profile's directory, `home` the default profile's. */
export function createPrivateDir (from: string, home: string, tmp = tmpdir()): string {
  const dir = mkdtempSync(join(tmp, PRIVATE_PREFIX))
  chmodSync(dir, 0o700)
  for (const file of SNAPSHOT_FILES) {
    if (existsSync(join(from, file))) cpSync(join(from, file), join(dir, file))
  }
  copyPublicSeed(home, dir)
  return dir
}

/** The session says it is running, and which process it is. The boot time
 * recorded beside the pid is what lets a later sweep tell this process from
 * one the OS has since reused the pid for (pid-liveness.ts). */
export function markPrivate (dir: string, pid: number, now = Date.now(), uptimeSec = uptime()): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, MARKER), JSON.stringify({ pid, startedAt: now, bootTime: bootTimeMs(now, uptimeSec) }))
  } catch {
    // The sweep then treats it as a directory whose process has not said, and waits out the grace.
  }
}

export const isPrivateDirName = (name: string): boolean => NAME.test(name)

/** Removes a private directory: only one made here (named as mkdtemp names it, directly under the temp directory, no link). */
export function removePrivateDir (dir: string, tmp = tmpdir()): boolean {
  const target = resolve(dir)
  if (dirname(target) !== resolve(tmp) || !isPrivateDirName(basename(target))) return false
  try {
    if (!lstatSync(target).isDirectory()) return false
    // Retried: on Windows a file Chromium has just closed is briefly still open.
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return !existsSync(target)
  } catch {
    return false
  }
}

export interface SweepOptions {
  readonly tmp?: string
  readonly now?: number
  /** The machine's uptime, for the boot-time check pid-liveness.ts does before trusting `isAlive`. */
  readonly uptimeSec?: number
  readonly isAlive?: (pid: number) => boolean
  /** The user id that must own a directory for it to be removed. Absent where there is none (Windows). */
  readonly uid?: number | undefined
}

/** Removes the private directories of sessions that are over: those owned by this user, not a link, whose process is gone
 * (or, with no marker, that are older than the grace). Never throws. Returns the names removed. */
export function sweepPrivateDirs (options: SweepOptions = {}): string[] {
  const tmp = options.tmp ?? tmpdir()
  const now = options.now ?? Date.now()
  const uptimeSec = options.uptimeSec ?? uptime()
  const isAlive = options.isAlive ?? processIsAlive
  const uid = 'uid' in options ? options.uid : process.getuid?.()
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(tmp)
  } catch {
    return removed
  }
  for (const name of names) {
    if (!isPrivateDirName(name)) continue
    const dir = join(tmp, name)
    try {
      const stat = lstatSync(dir)
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue
      const record = readMarker(dir)
      if (record === null ? now - stat.mtimeMs < GRACE_MS : isPidRecordAlive(record, isAlive, now, uptimeSec)) continue
      if (removePrivateDir(dir, tmp)) removed.push(name)
    } catch {
      // Gone already, or not ours to look at.
    }
  }
  return removed
}

function readMarker (dir: string): PidRecord | null {
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as { pid?: unknown, bootTime?: unknown }
    if (typeof marker.pid !== 'number') return null
    return typeof marker.bootTime === 'number' ? { pid: marker.pid, bootTime: marker.bootTime } : { pid: marker.pid }
  } catch {
    return null
  }
}
