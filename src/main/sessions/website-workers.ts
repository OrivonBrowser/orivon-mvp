// What an allowed app that runs in the shared session must not inherit from the website its origin was before: the
// workers and response caches that website installed, which the shell's check never saw. It reaches a session's storage
// through the one call it needs, so a unit test needs no Electron, and it keeps one empty file per origin it has cleared.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { originHash } from '../../broker/grants/origin-hash.js'

/** The part of a session this file uses: an Electron `Session` has it. */
export interface WorkerStorage {
  clearStorageData: (options: { origin: string, storages: Array<'serviceworkers' | 'cachestorage'> }) => Promise<void>
}

/** Which origins have had their website workers cleared, so a restart does not clear the app's own. */
export interface ClearedOrigins {
  has: (origin: string) => boolean
  add: (origin: string) => void
}

/**
 * Drops `origin`'s service workers and Cache Storage in `target`. A worker the website registered would otherwise answer
 * the app's requests with bytes the declared tree was never asked about, and the app registers its own, through the check,
 * on its first load. What the site stored beyond that (its data) stays: one origin has one set of data.
 */
export async function forgetWebsiteWorkers (target: WorkerStorage, origin: string): Promise<void> {
  await target.clearStorageData({ origin, storages: ['serviceworkers', 'cachestorage'] })
}

/**
 * Run before an app that runs in the shared session is served, `from` its pin or live. Served live, the app was a website
 * there a moment ago (a first visit), so its workers go every time. Served from its pin at a start, they go once: an app
 * that moved to the shared session from a partition of its own finds the website's workers there already, and the app's
 * own, registered after, are left alone from then on.
 */
export async function prepareWebsiteWorkers (target: WorkerStorage, origin: string, from: 'pin' | 'verifier', cleared: ClearedOrigins): Promise<void> {
  if (from === 'pin' && cleared.has(origin)) return
  await forgetWebsiteWorkers(target, origin)
  cleared.add(origin)
}

/** The cleared origins as empty files in `directory`, named by the origin's hash. */
export function clearedOriginsIn (directory: string): ClearedOrigins {
  return {
    has: (origin) => existsSync(join(directory, originHash(origin))),
    add: (origin) => {
      // A mark that cannot be written only means the next start clears again.
      try {
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, originHash(origin)), '')
      } catch {
        // Nothing to do: serving the app does not wait on a file.
      }
    }
  }
}

/** The cleared origins of a session that keeps nothing on disk. */
export function clearedOriginsInMemory (): ClearedOrigins {
  const cleared = new Set<string>()
  return { has: (origin) => cleared.has(origin), add: (origin) => { cleared.add(origin) } }
}
