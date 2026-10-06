// How long what a document opened from this computer stores, derives and holds lasts. Every
// local-file fact that depends on the answer reads it here, so changing the lifetime from
// "until Orivon quits" to "kept" is a change to this file and to what sweeps `LOCAL_DATA_DIR`.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { isLocalFileKey } from '../policy/origin.js'

/** Where a local file's `fs` root lives: its own tree beside `app-data/`, emptied at start and at quit. */
export const LOCAL_DATA_DIR = 'app-data-local'

const RUN_ID = randomBytes(8).toString('hex')

/** This run's id: 16 lowercase hex characters, new every time Orivon starts. */
export function runId (): string {
  return RUN_ID
}

/**
 * The string `id` and `secrets` derive their per-origin key from. A web origin derives from itself;
 * a local file derives from its key and this run's id, so its keys differ in every run.
 */
export function derivationScope (key: string, run: string = RUN_ID): string {
  return isLocalFileKey(key) ? `${key}\n#run=${run}` : key
}

/** The folder holding every local file's data, for the sweep. */
export function localDataBase (userDataPath: string): string {
  return join(userDataPath, LOCAL_DATA_DIR)
}

/** One local file's `fs` root parent for this run; `hash` is that file key's `originHash`. */
export function localDataRoot (userDataPath: string, hash: string, run: string = RUN_ID): string {
  return join(localDataBase(userDataPath), run, hash)
}
