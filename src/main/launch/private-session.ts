// A private session's directory: made fresh, holding a copy of the settings it
// began with and nothing else, and removed when the session is over. Deleting it
// is never claimed to happen inside the dying process: Chromium writes after quit
// and Windows will not delete a file that is open. The browser that opened the
// session removes it when the process exits, and the next start of any browser
// sweeps what a crash left.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const PRIVATE_PREFIX = 'orivon-private-'
const MARKER = '.orivon-private.json'
/** mkdtemp's suffix: six characters. */
const NAME = new RegExp(`^${PRIVATE_PREFIX}[A-Za-z0-9]{6}$`)
/** A directory with no marker yet may be one whose process has not written it. */
export const GRACE_MS = 10 * 60 * 1000

/** What a private session starts with, copied from the profile that opened it: its settings, and the light client's
 * verified checkpoint, which is public and without which a `.eth` name would fail once the shipped one is old. Never
 * history, bookmarks, grants, apps, identity or site data. */
export const SNAPSHOT_FILES = ['settings.json'] as const
export const SNAPSHOT_FROM_HOME = ['verifier'] as const

/** Makes the directory. `from` is the opening profile's directory, `home` the default profile's. */
export function createPrivateDir (from: string, home: string, tmp = tmpdir()): string {
  const dir = mkdtempSync(join(tmp, PRIVATE_PREFIX))
  chmodSync(dir, 0o700)
  for (const file of SNAPSHOT_FILES) {
    if (existsSync(join(from, file))) cpSync(join(from, file), join(dir, file))
  }
  for (const item of SNAPSHOT_FROM_HOME) {
    if (existsSync(join(home, item))) cpSync(join(home, item), join(dir, item), { recursive: true, dereference: false })
  }
  return dir
}

/** The session says it is running, and which process it is. */
export function markPrivate (dir: string, pid: number, now = Date.now()): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, MARKER), JSON.stringify({ pid, startedAt: now }))
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
  readonly isAlive?: (pid: number) => boolean
  /** The user id that must own a directory for it to be removed. Absent where there is none (Windows). */
  readonly uid?: number | undefined
}

/** Removes the private directories of sessions that are over: those owned by this user, not a link, whose process is gone
 * (or, with no marker, that are older than the grace). Never throws. Returns the names removed. */
export function sweepPrivateDirs (options: SweepOptions = {}): string[] {
  const tmp = options.tmp ?? tmpdir()
  const now = options.now ?? Date.now()
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
      const pid = readPid(dir)
      if (pid === null ? now - stat.mtimeMs < GRACE_MS : isAlive(pid)) continue
      if (removePrivateDir(dir, tmp)) removed.push(name)
    } catch {
      // Gone already, or not ours to look at.
    }
  }
  return removed
}

function readPid (dir: string): number | null {
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as { pid?: unknown }
    return typeof marker.pid === 'number' ? marker.pid : null
  } catch {
    return null
  }
}

function processIsAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
