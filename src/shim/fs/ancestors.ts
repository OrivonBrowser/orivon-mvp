// The directories ABOVE the app's files root: `/` and every parent of
// VIRTUAL_ROOT (`/orivon`). A Node program that makes a folder walks them
// (`mkdirp`, a config loader, `find-up`: stat each ancestor from `/`, make the
// ones that are not directories), and in a real process they exist. Here they
// exist too, as directories nobody can write to, and they hold exactly one
// thing: the next segment toward the files root. They never hold a real file,
// so nothing outside the app's own folder (or a picked path) becomes readable.
//
// Only the calls a walk makes are answered: stat, lstat, access, existsSync,
// realpath, `mkdir` (which exists already) and readdir. Everything else on an
// ancestor, and every path that is neither an ancestor nor under the root,
// still meets toConfinedPath's EACCES. README.md's Design notes has the rest.

import { normalize } from 'path/posix'
import type { FileStat } from '../../contracts/handles.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'
import { fsError } from './paths.js'

const ROOT_SEGMENTS = VIRTUAL_ROOT.slice(1).split('/')

/** A synthetic directory: an ancestor has no real size or mtime to report. */
const ANCESTOR_STAT: FileStat = { size: 0, isFile: false, isDirectory: true, mtimeMs: 0 }

export interface Ancestor {
  /** The ancestor's normalised absolute path: `/` or `/orivon`. */
  readonly path: string
  /** The one entry it lists: the next segment toward the files root. */
  readonly child: string
}

/** `/` or a strict parent of the files root, after POSIX normalisation, else `undefined`. A relative path, the root itself and anything under it are not ancestors. */
export function ancestorOf (text: string): Ancestor | undefined {
  if (!text.startsWith('/')) return undefined
  const path = normalize(text).replace(/(.)\/+$/, '$1')
  const segments = path === '/' ? [] : path.slice(1).split('/')
  if (segments.length >= ROOT_SEGMENTS.length) return undefined
  if (segments.some((segment, index) => segment !== ROOT_SEGMENTS[index])) return undefined
  const child = ROOT_SEGMENTS[segments.length]
  return child === undefined ? undefined : { path, child }
}

export function ancestorStat (): FileStat { return ANCESTOR_STAT }

/** `mkdir` of a directory that exists: Node's own outcome, with and without `recursive`. */
export function assertAncestorMkdirAllowed (ancestor: Ancestor, opts: { recursive?: boolean } | undefined): void {
  if (opts?.recursive === true) return
  throw fsError('EEXIST', 'file already exists', 'mkdir', ancestor.path)
}
