// What an allowed app that runs in the shared session must not inherit from the website its origin was before: the
// workers and response caches that website installed, which the shell's check never saw. Electron-bound (a session's
// storage), and holds no state of its own.

/** The part of a session this file uses: an Electron `Session` has it. */
export interface WorkerStorage {
  clearStorageData: (options: { origin: string, storages: Array<'serviceworkers' | 'cachestorage'> }) => Promise<void>
}

/**
 * Drops `origin`'s service workers and Cache Storage in `target`. Run when the origin is first served as an app, before
 * the tab loads as one: a worker the website registered would otherwise answer the app's requests with bytes the
 * declared tree was never asked about, and the app registers its own, through the check, on its first load. What the site
 * stored beyond that (its data) stays: one origin has one set of data.
 */
export async function forgetWebsiteWorkers (target: WorkerStorage, origin: string): Promise<void> {
  await target.clearStorageData({ origin, storages: ['serviceworkers', 'cachestorage'] })
}
