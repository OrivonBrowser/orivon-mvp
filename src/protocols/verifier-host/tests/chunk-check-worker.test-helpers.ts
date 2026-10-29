import { fileURLToPath } from 'node:url'
import { chunkCheckWorkerCode } from '../../../../scripts/chunk-check-worker-bundle.js'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

let built: Promise<string> | undefined

/** The code of the chunk check thread, built as the main build builds it (once per test file). */
export async function builtChunkCheckWorker (): Promise<string> {
  built ??= chunkCheckWorkerCode(ROOT)
  return await built
}
