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
  | { readonly kind: 'private', readonly home: string, readonly dir: string | null, readonly tunnel?: PrivateTunnel }

/** What a private session is forced to send everything through, from its first instant to its end. Absent: the session follows the settings it began with. */
export type PrivateTunnel = 'nym'

export const DEFAULT_PROFILE_ID = 'default'
/** The shape of an id this browser made: twelve random lowercase hexadecimal characters, never a path. Checked before any path is built from one. */
export const PROFILE_ID = /^[0-9a-f]{12}$/

const PROFILE_FLAG = '--orivon-profile='
const PRIVATE_FLAG = '--orivon-private'
const PRIVATE_DIR_FLAG = '--orivon-private-dir='
const PRIVATE_TUNNEL_FLAG = '--orivon-private-tunnel='
/** What a package tagged for an app passes on its first launch (`../flavour/`): the id of an allowlisted app, never an address. */
export const FLAVOUR_FLAG = '--orivon-flavour='

/** What a launcher action passes (a dock or taskbar menu entry, a desktop-entry action). */
export const NEW_WINDOW_FLAG = '--new-window'
export const NEW_PRIVATE_WINDOW_FLAG = '--new-private-window'

export type LaunchParse = { readonly ok: true, readonly launch: Launch } | { readonly ok: false, readonly problem: string }

/** The command line up to the first `--`, which ends the switches: what follows is a link or file, and may carry anything. */
export function switchesOf (argv: readonly string[]): readonly string[] {
  const end = argv.indexOf('--')
  return end === -1 ? argv : argv.slice(0, end)
}

/** The launch the command line asks for. `home` is where the default profile's data is. */
export function parseLaunch (command: readonly string[], home: string): LaunchParse {
  const argv = switchesOf(command)
  const profiles = argv.filter((argument) => argument.startsWith(PROFILE_FLAG))
  const isPrivate = argv.includes(PRIVATE_FLAG)
  if (isPrivate && profiles.length > 0) return { ok: false, problem: 'a private session cannot also be a profile' }
  if (profiles.length > 1) return { ok: false, problem: 'more than one profile was named' }
  // The bare switch and a value given as a separate argument are tunnel requests that name none, and are refused with the rest.
  const tunnels = argv.filter((argument) => argument === PRIVATE_TUNNEL_FLAG.slice(0, -1) || argument.startsWith(PRIVATE_TUNNEL_FLAG))
  if (tunnels.length > 0 && !isPrivate) return { ok: false, problem: 'a tunnel for the whole session is only for a private session' }
  if (isPrivate) {
    const dir = argv.find((argument) => argument.startsWith(PRIVATE_DIR_FLAG))?.slice(PRIVATE_DIR_FLAG.length)
    if (tunnels.length > 1) return { ok: false, problem: 'more than one tunnel was named' }
    const named = tunnels[0]?.slice(PRIVATE_TUNNEL_FLAG.length)
    // A tunnel this build does not know is refused, never read as none: the session was asked to stay inside one.
    if (named !== undefined && named !== 'nym') return { ok: false, problem: `"${named}" is not a tunnel a private session can be held to` }
    return { ok: true, launch: { kind: 'private', home, dir: dir === undefined || dir === '' ? null : dir, ...(named === undefined ? {} : { tunnel: 'nym' as const }) } }
  }
  const named = profiles[0]?.slice(PROFILE_FLAG.length)
  if (named === undefined || named === DEFAULT_PROFILE_ID) return { ok: true, launch: { kind: 'default', home, dir: home } }
  if (!PROFILE_ID.test(named)) return { ok: false, problem: `"${named}" is not the id of a profile` }
  return { ok: true, launch: { kind: 'profile', id: named, home, dir: join(home, 'profiles', named) } }
}

/** The value of `--orivon-flavour=` before the first `--`, or undefined when it was not given. Given twice it is the empty text,
 * which names no app: two tags are one too many to choose between. */
export function flavourSwitch (command: readonly string[]): string | undefined {
  const given = switchesOf(command).filter((argument) => argument.startsWith(FLAVOUR_FLAG))
  if (given.length === 0) return undefined
  return given.length > 1 ? '' : given[0]?.slice(FLAVOUR_FLAG.length)
}

/** The flags that start another process as `launch`, for the peer spawn. */
export function flagsFor (launch: { kind: 'profile', id: string } | { kind: 'private', dir: string, tunnel?: PrivateTunnel }): string[] {
  if (launch.kind === 'profile') return [`${PROFILE_FLAG}${launch.id}`]
  return [PRIVATE_FLAG, `${PRIVATE_DIR_FLAG}${launch.dir}`, ...(launch.tunnel === undefined ? [] : [`${PRIVATE_TUNNEL_FLAG}${launch.tunnel}`])]
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

/**
 * `args` (the command line after the program) with only its switches left, and the app path of a run from source:
 * starting the browser again opens no address, local file or path operand a second time, however it was named
 * (a link, a `file:` URI, a plain path, or anything after `--`), and no launcher action either.
 */
export function withoutAddresses (args: readonly string[], packaged = true): string[] {
  const kept: string[] = []
  let appPathPending = !packaged
  for (const argument of switchesOf(args)) {
    if (argument.startsWith('-')) {
      if (argument !== NEW_WINDOW_FLAG && argument !== NEW_PRIVATE_WINDOW_FLAG) kept.push(argument)
    } else if (appPathPending) {
      appPathPending = false
      kept.push(argument)
    }
  }
  return kept
}
