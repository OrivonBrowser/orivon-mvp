// "Delete data" for a file opened from this computer: its grants, its session, its folder of saved files, and
// its record, so that it is a file nobody has let use Orivon permissions again. What the page stored while it shared the
// local-files session with every other file is that session's, and has its own button (the privacy page).
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Broker } from '../../broker/broker-contracts.js'
import { appDataRoot } from '../../broker/grants/origin-hash.js'
import { isLocalFileKey } from '../../broker/policy/origin.js'
import { appRootDirectoryName } from '../../loader/index.js'
import { dropLocalFileGrants } from './drop-local-file-grants.js'
import { isRecordedLocalFile, localFileApps } from './local-file-apps.js'
import { localPartitionFor } from './partition.js'

export interface DeleteLocalFileDataDeps {
  readonly broker: Broker | undefined
  readonly userDataPath: string
  /** Clears everything the session `partition` stores. */
  readonly clearPartition: (partition: string) => Promise<void>
}

/**
 * True when every step succeeded. A step that fails is logged and the others still run, the record last of all but
 * always: a file with no grants and no way to hold any has nothing to keep a record for.
 */
export async function deleteLocalFileData (deps: DeleteLocalFileDataDeps, key: string): Promise<boolean> {
  if (!isLocalFileKey(key)) return false
  // Read before the record goes: it is what names the file's own session.
  const partition = isRecordedLocalFile(key) ? localPartitionFor(key) : undefined
  let clean = true
  const attempt = async (what: string, step: () => Promise<unknown>): Promise<void> => {
    try {
      await step()
    } catch (error) {
      clean = false
      console.error(`[local-files] could not delete a file's ${what}:`, error)
    }
  }
  if (deps.broker !== undefined) {
    const { broker } = deps
    await attempt('grants', async () => { await dropLocalFileGrants(broker, key) })
  }
  if (partition !== undefined) await attempt('session', async () => { await deps.clearPartition(partition) })
  await attempt('saved files', async () => {
    await rm(appDataRoot(deps.userDataPath, key), { recursive: true, force: true })
    await rm(join(deps.userDataPath, 'apps', appRootDirectoryName(key)), { recursive: true, force: true })
  })
  if (localFileApps()?.remove(key) === false && isRecordedLocalFile(key)) clean = false
  return clean
}
