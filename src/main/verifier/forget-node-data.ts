// Forgetting what the nodes and the verifier host kept about the sites visited: the IPFS node's store and the
// Swarm chunks the host keeps on disk (`protocols/verifier-host/swarm-chunk-database.ts`). A decision file: no
// Electron, so a test drives it over a real directory.

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { swarmChunkFilesIn } from '../../protocols/verifier-host/swarm-chunk-files.js'

/** How long forgetting waits for the host's process to exit before it deletes the files the process keeps open. */
export const HOST_EXIT_WAIT_MS = 10_000

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

export interface ForgetDeps {
  /** Stops the IPFS node and deletes its store. */
  readonly forgetIpfsNode: () => Promise<void>
  /** Replaces the partition salt and returns the new one. */
  readonly replaceSalt: () => string
  /** Puts the verifier host to sleep, so its process exits; it holds the old salt from its start, and its next start is given the new one. */
  readonly sleepHost: () => void
  /** Resolves once a process told to leave has exited. */
  readonly hostGone: () => Promise<void>
  /** The verifier's directory in the profile. */
  readonly directory: () => string
}

/**
 * The salt is replaced, so nothing kept can be asked for again; then the host exits (it holds its database open),
 * and its files go. An exit that does not come in `HOST_EXIT_WAIT_MS` is not waited for any longer. A step that
 * fails does not stop the others, so a store the IPFS node could not delete does not keep the Swarm chunks; the
 * first failure is thrown at the end.
 */
export async function forgetNodeData (deps: ForgetDeps): Promise<void> {
  let failure: unknown
  try {
    await deps.forgetIpfsNode()
  } catch (error) {
    failure = error
  }
  const salt = deps.replaceSalt()
  deps.sleepHost()
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, HOST_EXIT_WAIT_MS) })
  try {
    await Promise.race([deps.hostGone(), limit])
  } finally {
    clearTimeout(timer)
  }
  try {
    await removeSwarmChunkFiles(deps.directory(), salt)
  } catch (error) {
    failure ??= error
  }
  if (failure !== undefined) throw failure
}
