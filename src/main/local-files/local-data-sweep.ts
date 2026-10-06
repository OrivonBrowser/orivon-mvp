import { rmSync } from 'node:fs'
import { localDataBase } from '../../broker/grants/local-file-lifetime.js'

/**
 * Removes every local file's saved data (`LOCAL_DATA_DIR` under `userDataPath`). Run at start, for a
 * run that did not get to quit cleanly, and at quit. A folder that cannot be removed is reported and
 * left, never thrown: quitting must not be held up by it.
 */
export function sweepLocalData (userDataPath: string, remove: (path: string) => void = (path) => { rmSync(path, { recursive: true, force: true }) }): boolean {
  try {
    remove(localDataBase(userDataPath))
    return true
  } catch (error) {
    console.error('[local-files] could not remove the saved data of local files:', error)
    return false
  }
}
