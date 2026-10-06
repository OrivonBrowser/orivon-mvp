import { originHash } from '../../broker/grants/origin-hash.js'
import { localFileKey } from '../../broker/policy/origin.js'
import { isRecordedLocalFile, localFileApps } from './local-file-apps.js'

/**
 * The session every local file runs in until the person lets it use Orivon permissions. Persistent, so
 * what a page keeps there stays, as a website's does; no cookie is shared with the web and no extension
 * loads here, which is why a session of this kind can exist at all (extensions span the default session).
 */
export const LOCAL_FILES_PARTITION = 'persist:orivon-local-files'

const PER_FILE_PREFIX = 'persist:local-'

/**
 * The session `url`, a local file, belongs in: a session of its own once the file is recorded
 * (`local-file-apps.ts`), the shared one before. Undefined for anything that is not a local file.
 * Every decision about which session a file may load in goes through this one function.
 */
export function localPartitionFor (url: string): string | undefined {
  const key = localFileKey(url)
  if (key === null) return undefined
  return isRecordedLocalFile(key) ? `${PER_FILE_PREFIX}${originHash(key)}` : LOCAL_FILES_PARTITION
}

/** Whether `partition` is the shared local-files session or a recorded file's own. */
export function isLocalPartition (partition: string | undefined): boolean {
  return partition === LOCAL_FILES_PARTITION || partition?.startsWith(PER_FILE_PREFIX) === true
}

/** Every local session there is: the shared one and one for each recorded file. */
export function allLocalPartitions (): string[] {
  const recorded = (localFileApps()?.list() ?? []).map((key) => localPartitionFor(key))
  return [LOCAL_FILES_PARTITION, ...recorded.filter((partition): partition is string => partition !== undefined)]
}

/** Chromium's `ERR_BLOCKED_BY_CLIENT`: what a request an embedder's `webRequest` listener cancelled reports. */
const BLOCKED_BY_CLIENT = -20

/**
 * Where a tab must move when a main-frame load of a `file:` document failed as blocked: the fence
 * (`local-file-fence.ts`) cancels a file that belongs to another local session, and the file's own
 * session is the answer. Undefined for any other failure, a frame, a URL that is no local file, and a
 * tab already where the file belongs; the last is what stops a swap looping.
 */
export function partitionAfterFileBlock (
  failedUrl: string,
  errorCode: number,
  isMainFrame: boolean,
  currentPartition: string | undefined
): string | undefined {
  if (errorCode !== BLOCKED_BY_CLIENT || !isMainFrame) return undefined
  const target = localPartitionFor(failedUrl)
  return target === currentPartition ? undefined : target
}
