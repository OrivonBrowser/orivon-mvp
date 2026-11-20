// Node's compile cache for the main process: the bundle (`out/main/index.js`) is one large script that V8 would compile
// from scratch at every start, and a cache of its compiled form is read back instead. Compiled code only, no personal
// data. `start.ts` calls this before it requires the bundle, so it loads only built-in modules, and `node:fs/promises`
// not until the folder is trimmed, since a start has no use for it before.
import { lstatSync, mkdirSync } from 'node:fs'
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
  readonly enable: (directory: string) => { readonly status: number, readonly message?: string, readonly directory?: string }
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

/** What `lstat` says about the folder, and all the check below reads. */
export interface FolderInfo {
  readonly isDirectory: () => boolean
  readonly isSymbolicLink: () => boolean
  readonly uid: number
  readonly mode: number
}

/** The part of the file system this uses, so a test can stand in for it. */
export interface FolderApi {
  /** Makes the folder, and its parents, for this user alone when it is new. */
  readonly make: (directory: string) => void
  /** Reads the folder itself: a link is reported as a link, never followed. */
  readonly inspect: (directory: string) => FolderInfo
}

const nodeFolder: FolderApi = {
  make: (directory) => { mkdirSync(directory, { recursive: true, mode: 0o700 }) },
  inspect: (directory) => lstatSync(directory)
}

/**
 * Why the folder may not be trusted with compiled code, or undefined when it may: V8 runs what an entry holds, so only a
 * real folder of this user's own that no one else can write is used. This keeps another account of the computer out;
 * a process running as this user is the one adversary the cache does not defend against (`security-model.md` T24).
 */
export function compileCacheFolderRefusal (info: FolderInfo, uid: number | undefined): string | undefined {
  if (info.isSymbolicLink()) return 'the folder is a link'
  if (!info.isDirectory()) return 'the folder is not a directory'
  if (uid === undefined || info.uid !== uid) return 'the folder belongs to another user'
  if ((info.mode & 0o022) !== 0) return 'the folder can be written by its group or by other users'
  return undefined
}

/** What `startCompileCache` reads from the process, each replaceable by a test. */
export interface CompileCacheDeps {
  readonly api?: CompileCacheApi
  readonly folder?: FolderApi
  readonly warn?: (line: string) => void
  readonly platform?: NodeJS.Platform
  /** The user this process runs as; undefined where the OS has no such number. */
  readonly uid?: number | undefined
}

/**
 * Turns the cache on and returns its folder, or undefined when it is off. Never throws and never stops a start: a cache
 * that cannot be opened is one line in the log and the bundle compiles as before. `NODE_DISABLE_COMPILE_CACHE=1` is
 * the person's choice and says nothing.
 *
 * On Linux and macOS the folder is made `0700` and checked first (`compileCacheFolderRefusal`). On Windows it sits under
 * the user's own profile path, whose ACL already admits that user alone, so nothing is made or checked there.
 */
export function startCompileCache (home: string, appPath: string, deps: CompileCacheDeps = {}): string | undefined {
  const api = deps.api ?? nodeApi
  const warn = deps.warn ?? console.warn
  const refuse = (reason: string): undefined => { warn(`[orivon] compile cache not used: ${reason}`) }
  if (runsFromChangingPath(appPath)) return refuse('this program runs from a path that changes at every start')
  const directory = compileCacheFolder(home)
  try {
    if ((deps.platform ?? process.platform) !== 'win32') {
      const folder = deps.folder ?? nodeFolder
      folder.make(directory)
      const refusal = compileCacheFolderRefusal(folder.inspect(directory), 'uid' in deps ? deps.uid : process.getuid?.())
      if (refusal !== undefined) return refuse(refusal)
    }
    const result = api.enable(directory)
    // Already on (NODE_COMPILE_CACHE in the environment): Node keeps writing to the folder it was given, and that is the one to trim.
    if (result.status === api.status.ENABLED || result.status === api.status.ALREADY_ENABLED) return result.directory ?? directory
    if (result.status !== api.status.DISABLED) refuse(result.message ?? 'it could not be opened')
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }
  return undefined
}

/**
 * Removes the oldest entries until the folder is at half its limit, when it is over it. A hit never rewrites an entry,
 * so the running build's are not always the newest, and one that goes is made again at the next start. Never throws:
 * a file another process removes first, or one Windows holds open, is skipped.
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
      try {
        await rm(entry.path, { force: true })
        total -= entry.size
      } catch { /* held open: the next one */ }
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
    // orivon:floating-ok -- `trimCompileCache` catches everything it can throw
    void trimCompileCache(directory)
  }, delayMs).unref()
}
