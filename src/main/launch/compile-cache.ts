// Node's compile cache for the main process: the bundle (`out/main/index.js`) is one large script that V8 would compile
// from scratch at every start, and a cache of its compiled form is read back instead. Compiled code only, no personal
// data. `start.ts` calls this before it requires the bundle, so it loads only built-in modules, and `node:fs/promises`
// not until the folder is trimmed, since a start has no use for it before.
import { constants, enableCompileCache, flushCompileCache } from 'node:module'
import { join } from 'node:path'

/** The folder, in the data directory every profile and private session shares: compiled code is the same for all of them. */
export const COMPILE_CACHE_FOLDER = 'compiled-code-cache'

/** What the folder may hold. An entry is made for each build and path that ran, and Node never removes an old one. */
export const COMPILE_CACHE_MAX_BYTES = 32 * 1024 * 1024

/** How long after the start the cache is written out (and trimmed): after the first window is long up, so no start waits for it. */
export const COMPILE_CACHE_SETTLE_MS = 15_000

/** The part of Node's API this uses, so a test can stand in for it. */
export interface CompileCacheApi {
  readonly enable: (directory: string) => { readonly status: number, readonly message?: string }
  readonly flush: () => void
  readonly status: { readonly ENABLED: number, readonly ALREADY_ENABLED: number, readonly FAILED: number, readonly DISABLED: number }
}

const nodeApi: CompileCacheApi = {
  enable: (directory) => enableCompileCache(directory),
  flush: flushCompileCache,
  status: constants.compileCacheStatus
}

export function compileCacheFolder (home: string): string {
  return join(home, COMPILE_CACHE_FOLDER)
}

/**
 * A cache entry is keyed on the file's path, so a program that runs from a path that is new at every start never reads
 * one back: an AppImage's mount and a macOS app that Gatekeeper moved to a random place. Those starts get no cache.
 */
export function runsFromChangingPath (appPath: string): boolean {
  const path = appPath.replace(/\\/g, '/')
  return /\/\.mount_[^/]+\//.test(path) || path.includes('/AppTranslocation/')
}

/**
 * Turns the cache on and returns its folder, or undefined when it is off. Never throws and never stops a start: a cache
 * that cannot be opened is one line in the log and the bundle compiles as before. `NODE_DISABLE_COMPILE_CACHE=1` is
 * the person's choice and says nothing.
 */
export function startCompileCache (home: string, appPath: string, api: CompileCacheApi = nodeApi, warn: (line: string) => void = console.warn): string | undefined {
  if (runsFromChangingPath(appPath)) {
    warn('[orivon] compile cache not used: this program runs from a path that changes at every start')
    return undefined
  }
  const directory = compileCacheFolder(home)
  try {
    const result = api.enable(directory)
    if (result.status === api.status.ENABLED || result.status === api.status.ALREADY_ENABLED) return directory
    if (result.status !== api.status.DISABLED) warn(`[orivon] compile cache not used: ${result.message ?? 'it could not be opened'}`)
  } catch (error) {
    warn(`[orivon] compile cache not used: ${error instanceof Error ? error.message : String(error)}`)
  }
  return undefined
}

/**
 * Removes the oldest entries until the folder is at half its limit, when it is over it. The newest entries are the
 * running build's, so they stay. Never throws: a file another process removes first is not an error.
 */
export async function trimCompileCache (directory: string, maxBytes: number = COMPILE_CACHE_MAX_BYTES): Promise<void> {
  try {
    const { readdir, rm, stat } = await import('node:fs/promises')
    const entries: Array<{ path: string, size: number, modified: number }> = []
    for (const found of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!found.isFile()) continue
      const path = join(found.parentPath, found.name)
      try {
        const info = await stat(path)
        entries.push({ path, size: info.size, modified: info.mtimeMs })
      } catch { /* gone already */ }
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    if (total <= maxBytes) return
    for (const entry of entries.sort((a, b) => a.modified - b.modified)) {
      if (total <= maxBytes / 2) return
      await rm(entry.path, { force: true })
      total -= entry.size
    }
  } catch { /* no folder, or one that cannot be read: nothing to trim */ }
}

/**
 * Writes the entries made so far, then trims the folder, once, `delayMs` from now. Node writes them at a clean exit too,
 * but a start that is killed or crashes would then leave none, and a flush costs main-process time that the first
 * window must not wait for. The timer never keeps the process alive.
 */
export function settleCompileCacheLater (directory: string, delayMs: number = COMPILE_CACHE_SETTLE_MS, api: CompileCacheApi = nodeApi): void {
  setTimeout(() => {
    try { api.flush() } catch { /* a cache miss is all it costs */ }
    void trimCompileCache(directory)
  }, delayMs).unref()
}
