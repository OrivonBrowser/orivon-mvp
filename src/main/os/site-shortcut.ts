// What a site's shortcut file says. The name and the address are a page's own words, so every byte that reaches the
// file is cleaned or escaped here: a line break in a title would start a new line of the file (an `Exec=` of the
// page's choosing), and an address is quoted so a space, `$(...)` or `%f` in it stays an argument and never a command.
import { createHash } from 'node:crypto'
import { oneLine } from './one-line.js'

export const MAX_NAME = 60
const MAX_SLUG = 40

/** The shortcut's name: one line, at most `MAX_NAME` characters, or `fallback` when nothing is left. */
export function cleanName (raw: string, fallback: string): string {
  const cut = Array.from(oneLine(raw)).slice(0, MAX_NAME).join('').trim()
  return cut === '' ? fallback : cut
}

/** `[a-z0-9-]` and nothing else, from the address's host: a part of a file name built in main. */
export function slugFor (address: string): string {
  let host = ''
  try {
    host = new URL(address).hostname
  } catch {
    host = ''
  }
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG).replace(/-+$/, '')
  return slug === '' ? 'site' : slug
}

/** The file's name. The same site in another profile is another file, so one does not replace the other. */
export function entryFileName (address: string, profileId?: string): string {
  const hash = createHash('sha256').update(profileId === undefined ? address : `${profileId}\n${address}`).digest('hex').slice(0, 8)
  return `orivon-${slugFor(address)}-${hash}.desktop`
}

/** A value of the string type in a desktop entry: a backslash is written twice. Line breaks never reach it. */
function entryString (value: string): string {
  return value.replace(/\\/g, '\\\\')
}

/** One argument of `Exec=`: in double quotes, with the characters a quoted argument still reads specially escaped,
 * then `%` doubled (a field code otherwise) and the file's own string escaping applied. */
export function execArgument (argument: string): string {
  const quoted = argument.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%')
  return `"${entryString(quoted)}"`
}

export interface EntryInput {
  readonly name: string
  readonly address: string
  /** The program, and the arguments that precede the address: the app's own path for a run from source. */
  readonly program: string
  readonly leading: readonly string[]
  readonly profileId?: string
}

const NO_CONTROL = /[\u0000-\u001f\u007f]/
/** Every run of control characters in a name: a line break there would start another line of the entry. */
const CONTROL_RUNS = /[\u0000-\u001f\u007f]+/g

/** The flags that open `input.address` in the profile it was made in. */
export function launchArguments (input: Pick<EntryInput, 'address' | 'leading' | 'profileId'>): string[] {
  return [...input.leading, ...(input.profileId === undefined ? [] : [`--orivon-profile=${input.profileId}`]), input.address]
}

export function desktopEntry (input: EntryInput): string {
  const arguments_ = [input.program, ...launchArguments(input)]
  if (arguments_.some((argument) => NO_CONTROL.test(argument))) throw new Error('an argument holds a control character')
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${entryString(input.name.replace(CONTROL_RUNS, ' '))}`,
    `Exec=${arguments_.map(execArgument).join(' ')}`,
    'Icon=orivon',
    'Terminal=false',
    'Categories=Network;WebBrowser;',
    ''
  ].join('\n')
}

/** Names Windows keeps for devices: a file called any of these, with any extension, cannot be created. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** A file name Windows accepts, from the shortcut's name. */
export function linkFileName (name: string): string {
  const safe = name.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim()
  if (safe === '') return 'Orivon.lnk'
  return `${RESERVED_NAME.test(safe) ? `${safe} (site)` : safe}.lnk`
}

/** The argument string of a Windows shortcut or task: each argument in double quotes. An address the URL parser produced holds no
 * quote, and a profile id is hexadecimal, so a quote here is refused rather than escaped. */
export function windowsArguments (all: readonly string[]): string {
  if (all.some((argument) => argument.includes('"') || NO_CONTROL.test(argument))) throw new Error('an argument cannot be quoted')
  return all.map((argument) => `"${argument}"`).join(' ')
}

export function linkArguments (input: Pick<EntryInput, 'address' | 'leading' | 'profileId'>): string {
  return windowsArguments(launchArguments(input))
}
