// Moves the session folders an earlier name left to their short names, once per start, before any session opens.
// Electron-free over the folder it is handed.
//
// A session was named `<kind>-<64 hex>` and is now `<kind>-<first 32 hex>` (`broker/grants/origin-hash.ts`), so
// `Partitions/app-<64 hex>` becomes `Partitions/app-<32 hex>`. Folders are renamed, never copied, merged or
// deleted: a folder that cannot move stays where it is and is tried again at the next start.

import { readdirSync, renameSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { HASHED_PARTITION_KINDS, PARTITION_HASH_LENGTH } from '../../broker/grants/origin-hash.js'

/** Hex digits in a whole `originHash`, the length of the name an earlier build gave. */
const LONG_HASH_LENGTH = 64
const LEGACY_FOLDER = new RegExp(`^(${HASHED_PARTITION_KINDS.join('|')})-([0-9a-f]{${String(LONG_HASH_LENGTH)}})$`)

/** Pauses before each further round on the folders a lock refused: Windows refuses a rename for as long as another process holds a file in the folder. */
const RETRY_DELAYS_MS = [100, 250, 650]
const LOCKED_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES'])

/**
 * What became of one folder: `moved`; `conflict` when the short name already holds data (nothing is merged or
 * overwritten); `failed` when the system refused, with its `code`; `gone` when the folder was no longer there.
 */
export type FolderOutcome = 'moved' | 'conflict' | 'failed' | 'gone'

export interface FolderMove {
  readonly from: string
  readonly to: string
  readonly outcome: FolderOutcome
  readonly code?: string
}

/** The file system calls the move makes, so a test can refuse any of them. */
export interface FolderIo {
  readonly list: (dir: string) => ReadonlyArray<{ readonly name: string, readonly isDirectory: boolean }>
  readonly rename: (from: string, to: string) => void
  /** Removes `dir` when it holds nothing and throws when it holds anything. */
  readonly removeEmpty: (dir: string) => void
  readonly wait: (ms: number) => void
}

const SYSTEM_IO: FolderIo = {
  list: (dir) => readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })),
  rename: renameSync,
  removeEmpty: rmdirSync,
  wait: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
}

/** The short name of a folder named `<kind>-<64 hex>`, and undefined for any other name. */
export function shortFolderName (name: string): string | undefined {
  const match = LEGACY_FOLDER.exec(name)
  return match === null ? undefined : `${match[1] as string}-${(match[2] as string).slice(0, PARTITION_HASH_LENGTH)}`
}

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'

const EXISTS_CODES: ReadonlySet<string> = new Set(['ENOTEMPTY', 'EEXIST'])

/** An empty folder in the way is removed (it holds no data); one that holds anything is a conflict. */
function moveOne (from: string, to: string, targetExists: boolean, io: FolderIo): FolderMove {
  if (targetExists) {
    try {
      io.removeEmpty(to)
    } catch (error) {
      const code = codeOf(error)
      if (EXISTS_CODES.has(code)) return { from, to, outcome: 'conflict', code }
      if (code !== 'ENOENT') return { from, to, outcome: 'failed', code }
    }
  }
  try {
    io.rename(from, to)
    return { from, to, outcome: 'moved' }
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT') return { from, to, outcome: 'gone', code }
    return { from, to, outcome: EXISTS_CODES.has(code) ? 'conflict' : 'failed', code }
  }
}

/** Short enough to read in a log line and still tell two folders apart. */
const shown = (name: string): string => name.slice(0, name.indexOf('-') + 9)

function describe (move: FolderMove, partitions: string): string {
  const name = shown(move.from.slice(partitions.length + 1))
  if (move.outcome === 'moved') return `[partitions] moved ${name} to its short name`
  if (move.outcome === 'gone') return `[partitions] ${name} was no longer there to move`
  if (move.outcome === 'conflict') return `[partitions] ${name} stays under its long name: the short name already holds data, and nothing is merged or overwritten`
  return `[partitions] ${name} could not be moved (${move.code ?? 'UNKNOWN'}); it stays and is tried again at the next start`
}

/**
 * Renames every `Partitions/<kind>-<64 hex>` under `userData` to its short name. A folder the system refuses because a
 * process holds it is tried again after a short pause, three times at most; any other refusal waits for the next
 * start. Every folder's outcome is logged (`orivon://report` shows the log), and nothing is logged when no folder
 * has the long name. Never throws.
 */
export function moveLongNamedPartitionFolders (userData: string, io: FolderIo = SYSTEM_IO): readonly FolderMove[] {
  const partitions = join(userData, 'Partitions')
  let entries: ReturnType<FolderIo['list']>
  try {
    entries = io.list(partitions)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') console.warn(`[partitions] could not read the session folders (${codeOf(error)}); none was moved`)
    return []
  }
  const present = new Set(entries.map((entry) => entry.name))
  let waiting = entries.filter((entry) => entry.isDirectory && shortFolderName(entry.name) !== undefined).map((entry) => entry.name)
  const moves: FolderMove[] = []
  for (let round = 0; waiting.length > 0; round += 1) {
    const refused: string[] = []
    for (const name of waiting) {
      const short = shortFolderName(name) as string
      const move = moveOne(join(partitions, name), join(partitions, short), present.has(short), io)
      if (move.outcome === 'failed' && LOCKED_CODES.has(move.code ?? '') && round < RETRY_DELAYS_MS.length) refused.push(name)
      else moves.push(move)
    }
    const pause = RETRY_DELAYS_MS[round]
    if (refused.length === 0 || pause === undefined) break
    io.wait(pause)
    waiting = refused
  }
  for (const move of moves) (move.outcome === 'moved' ? console.log : console.warn)(describe(move, partitions))
  return moves
}
