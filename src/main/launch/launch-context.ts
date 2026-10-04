// Which browser this process is: the default one, another profile, or a private
// session. A process is exactly one of them for its whole life, because one
// process holds one broker, one grant ledger and one set of stores, all under
// one data directory. Pure: reading the command line, and no more.
import { join } from 'node:path'

/** `home` is where the default profile keeps what it keeps: the directory Electron chose for the app. Other profiles sit inside it. */
export type Launch =
  | { readonly kind: 'default', readonly home: string, readonly dir: string }
  | { readonly kind: 'profile', readonly id: string, readonly home: string, readonly dir: string }
  /** `dir` is a fresh directory the session owns, made by the browser that opened it (with a copy of its settings in it); null when nothing made one. */
  | { readonly kind: 'private', readonly home: string, readonly dir: string | null }

export const DEFAULT_PROFILE_ID = 'default'
/** The shape of an id this browser made: twelve random lowercase hexadecimal characters, never a path. Checked before any path is built from one. */
export const PROFILE_ID = /^[0-9a-f]{12}$/

const PROFILE_FLAG = '--orivon-profile='
const PRIVATE_FLAG = '--orivon-private'
const PRIVATE_DIR_FLAG = '--orivon-private-dir='

export type LaunchParse = { readonly ok: true, readonly launch: Launch } | { readonly ok: false, readonly problem: string }

/** The launch the command line asks for. `home` is where the default profile's data is. */
export function parseLaunch (argv: readonly string[], home: string): LaunchParse {
  const profiles = argv.filter((argument) => argument.startsWith(PROFILE_FLAG))
  const isPrivate = argv.includes(PRIVATE_FLAG)
  if (isPrivate && profiles.length > 0) return { ok: false, problem: 'a private session cannot also be a profile' }
  if (profiles.length > 1) return { ok: false, problem: 'more than one profile was named' }
  if (isPrivate) {
    const dir = argv.find((argument) => argument.startsWith(PRIVATE_DIR_FLAG))?.slice(PRIVATE_DIR_FLAG.length)
    return { ok: true, launch: { kind: 'private', home, dir: dir === undefined || dir === '' ? null : dir } }
  }
  const named = profiles[0]?.slice(PROFILE_FLAG.length)
  if (named === undefined || named === DEFAULT_PROFILE_ID) return { ok: true, launch: { kind: 'default', home, dir: home } }
  if (!PROFILE_ID.test(named)) return { ok: false, problem: `"${named}" is not the id of a profile` }
  return { ok: true, launch: { kind: 'profile', id: named, home, dir: join(home, 'profiles', named) } }
}

/** The flags that start another process as `launch`, for the peer spawn. */
export function flagsFor (launch: { kind: 'profile', id: string } | { kind: 'private', dir: string }): string[] {
  return launch.kind === 'profile' ? [`${PROFILE_FLAG}${launch.id}`] : [PRIVATE_FLAG, `${PRIVATE_DIR_FLAG}${launch.dir}`]
}

const ADDRESS_ARGUMENT = /^https?:\/\//i

/** The http and https addresses on a command line, for a second launch to open. Never a scheme the address bar would refuse. */
export function urlsFromArgv (argv: readonly string[], limit = 8): string[] {
  const urls: string[] = []
  for (const argument of argv) {
    if (urls.length >= limit) break
    if (!ADDRESS_ARGUMENT.test(argument)) continue
    try {
      urls.push(new URL(argument).toString())
    } catch {
      // Not an address after all.
    }
  }
  return urls
}

/** A command line without the addresses on it: starting the browser again opens none of them a second time. */
export function withoutAddresses (argv: readonly string[]): string[] {
  return argv.filter((argument) => !ADDRESS_ARGUMENT.test(argument))
}
