// The throwaway profile `npm run dev` runs on (scripts/dev.mjs, docs/development/setup.md
// "The dev profile"): made for each launch and deleted once nothing runs on it. A profile
// opened from the launch is a detached process on a directory inside it, and may outlive the
// launch; the profile is then left for the next launch to delete.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'orivon-dev-profile-'
/** mkdtemp's suffix: six characters. */
const NAME = new RegExp(`^${PREFIX}[A-Za-z0-9]{6}$`)
/** The `npm run dev` that made the profile: it is in use before its browser has started. */
const LAUNCHER = '.orivon-dev-launcher'
/** What a browser writes in its profile's directory while it runs (src/main/launch/profile-store.ts). */
const RUNNING = '.orivon-running'
const SKIP_INTRO = '--skip-intro'
const USER_DATA_DIR = '--user-data-dir='

/**
 * Electron's switches for this launch: what followed `npm run dev --`, less
 * dev.mjs's own --skip-intro, led by a fresh profile from `makeProfile`
 * unless they already name one.
 * @param {string[]} passed
 * @param {() => string} makeProfile
 * @returns {{ switches: string[], profile: string | null }}
 */
export function devSwitches (passed, makeProfile) {
  const switches = passed.filter((arg) => arg !== SKIP_INTRO)
  if (switches.some((arg) => arg.startsWith(USER_DATA_DIR))) return { switches, profile: null }
  const profile = makeProfile()
  return { switches: [`${USER_DATA_DIR}${profile}`, ...switches], profile }
}

/** @param {string} [tmp] @param {number} [pid] */
export function makeDevProfile (tmp = tmpdir(), pid = process.pid) {
  const dir = mkdtempSync(join(tmp, PREFIX))
  writeFileSync(join(dir, LAUNCHER), String(pid))
  return dir
}

/** @param {number} pid */
function processIsAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists and is not ours to signal.
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM'
  }
}

/** The pid a marker names, bare or as the running marker's `{ pid }`; null for none. @param {string} file */
function pidIn (file) {
  try {
    const text = readFileSync(file, 'utf8').trim()
    const pid = Number(text.startsWith('{') ? JSON.parse(text).pid : text)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * True while a process other than `self` runs on `dir`: the `npm run dev`
 * that made it, or a browser on it or on a profile inside it.
 * @param {string} dir
 * @param {(pid: number) => boolean} [isAlive]
 * @param {number} [self]
 */
export function profileInUse (dir, isAlive = processIsAlive, self = process.pid) {
  /** @type {string[]} */
  let profiles = []
  try {
    profiles = readdirSync(join(dir, 'profiles')).map((id) => join(dir, 'profiles', id))
  } catch {
    // No other profile was made.
  }
  const pids = [pidIn(join(dir, LAUNCHER)), ...[dir, ...profiles].map((profile) => pidIn(join(profile, RUNNING)))]
  return pids.some((pid) => pid !== null && pid !== self && isAlive(pid))
}

/**
 * Deletes `dir` unless something runs on it; true once it is gone. Never
 * throws: what is left, the next launch's sweep deletes.
 * @param {string} dir
 * @param {(dir: string) => boolean} [inUse]
 */
export function removeDevProfile (dir, inUse = profileInUse) {
  if (inUse(dir)) return false
  try {
    // Retried: on Windows a file Chromium has just closed is briefly still open.
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Left for the sweep.
  }
  return !existsSync(dir)
}

/**
 * Waits up to `ms` for the browser to finish quitting (Ctrl+C reaches
 * electron-vite, which exits at once, and Electron, which takes a moment),
 * then deletes `dir`.
 * @param {string} dir
 * @param {number} [ms]
 * @param {(dir: string) => boolean} [inUse]
 * @param {(ms: number) => void} [sleep]
 */
export function removeWhenDone (dir, ms = 10_000, inUse = profileInUse, sleep = sleepSync) {
  for (let waited = 0; waited < ms && inUse(dir); waited += 250) sleep(250)
  return removeDevProfile(dir, inUse)
}

/** Deletes the profiles earlier launches left. @param {string} [tmp] @param {(dir: string) => boolean} [inUse] */
export function sweepDevProfiles (tmp = tmpdir(), inUse = profileInUse) {
  /** @type {string[]} */
  let names = []
  try {
    names = readdirSync(tmp)
  } catch {
    return
  }
  for (const name of names) if (NAME.test(name)) removeDevProfile(join(tmp, name), inUse)
}

/** @param {number} ms */
function sleepSync (ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
