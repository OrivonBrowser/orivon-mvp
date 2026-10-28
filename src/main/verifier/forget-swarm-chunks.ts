// Deleting the Swarm chunks the verifier host keeps on disk (`protocols/verifier-host/swarm-chunk-database.ts`).
// A decision file: no Electron, so a test drives it over a real directory.

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { swarmChunkFilesIn } from '../../protocols/verifier-host/swarm-chunk-files.js'

/**
 * Deletes every kept-chunk file in `dir` (each database with its `-wal`, `-shm` and `-journal`) except those of
 * `exceptSalt`'s database, which a host started since the salt was replaced may already hold open. Every file is
 * tried before a failure is thrown, so one locked file does not keep the others; a host that opens its own
 * database deletes the files of every other salt, which is what takes the one that could not go.
 */
export async function removeSwarmChunkFiles (dir: string, exceptSalt?: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return
    throw error
  }
  let failure: unknown
  for (const name of swarmChunkFilesIn(names, exceptSalt)) {
    try {
      await rm(join(dir, name), { force: true })
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== undefined) throw failure
}
