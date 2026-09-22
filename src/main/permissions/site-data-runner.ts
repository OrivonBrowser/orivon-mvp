// The site-info popover's "Cookies and site data" page -- I/O, unlike
// ./site-info.js/./site-switches.js: real directory sizes, a real
// session's cookie jar, and (best-effort) a real page's own
// `navigator.storage.estimate()`. Split from those two by the
// code-guidelines.md naming convention (`-runner.ts` does I/O).
//
// TWO KINDS OF STORAGE, kept visibly separate: Orivon's own (private
// files, the pinned code copy -- `ADR-0003`'s tiers, measured straight off
// disk) and the page's ordinary browser storage (cookies, localStorage,
// IndexedDB, Cache -- measured through the tab's own JS, because Electron
// exposes no per-origin usage API at all; `session.getCacheSize()` is
// whole-session, and there is nothing narrower).

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session, WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { appRootDirectoryName } from '../../loader/index.js'

/**
 * Recursively sums file sizes under `root`. A missing root (nothing has
 * been written there yet) or an unlistable subtree contributes 0 rather
 * than throwing -- the same "absence is not an error" stance the loader's
 * own `pruneAssets` walker takes, for the identical reason: this runs
 * against a popover a person is looking at right now, and a raised
 * exception here must not take the whole page down over a directory that
 * simply is not there yet. Symlinks are never followed, matching every
 * other walker in this codebase (`node-storage.ts`'s own `walkFiles`).
 */
export async function directorySizeBytes (root: string): Promise<number> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      total += await directorySizeBytes(full)
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size
      } catch {
        // Raced away between readdir and stat -- contributes nothing,
        // same as never having existed.
      }
    }
  }
  return total
}

export interface OrivonStorageSnapshot {
  readonly filesBytes: number
  /** `manifest.capabilities.fs?.quotaBytes`, or `undefined` when the app never declared `fs` at all. */
  readonly filesQuotaBytes: number | undefined
  readonly codeBytes: number
  /** The pinned bundle's own version, or `undefined` when never pinned. */
  readonly codeVersion: string | undefined
}

/** Never calls `nodeFs`'s own `rootFor` (`../../broker/adapters/node-fs-
 * adapter.js`), which CREATES the directory -- this only ever measures
 * what is already there. */
export async function orivonStorageFor (
  userDataPath: string,
  origin: string,
  filesQuotaBytes: number | undefined,
  codeVersion: string | undefined
): Promise<OrivonStorageSnapshot> {
  const appRoot = join(userDataPath, 'apps', appRootDirectoryName(origin))
  const [filesBytes, codeBytes] = await Promise.all([
    directorySizeBytes(join(appRoot, 'files')),
    directorySizeBytes(join(appRoot, 'code'))
  ])
  return { filesBytes, filesQuotaBytes, codeBytes, codeVersion }
}

/** 0 on any failure -- an unreadable cookie jar reads as "nothing to show", not an error the popover surfaces. */
export async function cookieCountFor (session: Session, origin: string): Promise<number> {
  try {
    return (await session.cookies.get({ url: origin })).length
  } catch {
    return 0
  }
}

export interface BrowserStorageEstimate {
  readonly usageBytes: number
  readonly quotaBytes: number
}

/** Comfortably above Electron's own reserved isolated-world ids (0 is the
 * page's main world; Electron's context-isolation preloads run in a high
 * id of its own) -- nothing in this codebase uses an isolated world today. */
const STORAGE_ESTIMATE_WORLD_ID = 1000
const STORAGE_ESTIMATE_TIMEOUT_MS = 1500

function readNumber (value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * `navigator.storage.estimate()`, read from `origin`'s own tab through an
 * isolated world -- never the page's own (untrusted) main world, and never
 * the preloads' world. Best-effort throughout: `null` for anything that
 * goes wrong (no live webContents, the tab has navigated to a different
 * origin since this was asked for, the API is unsupported, the page never
 * responds inside `STORAGE_ESTIMATE_TIMEOUT_MS`) -- this page's whole
 * point is showing what CAN be observed, never guessing past a failure.
 */
export async function browserStorageEstimateFor (webContents: WebContents, origin: string): Promise<BrowserStorageEstimate | null> {
  if (webContents.isDestroyed() || originFromUrl(webContents.getURL()) !== origin) return null

  const script = {
    code: `(navigator.storage && navigator.storage.estimate)
      ? navigator.storage.estimate().then((e) => JSON.stringify({ usage: e.usage, quota: e.quota }))
      : Promise.resolve(null)`
  }
  const timeout = new Promise<null>((resolve) => { setTimeout(() => { resolve(null) }, STORAGE_ESTIMATE_TIMEOUT_MS) })

  let raw: unknown
  try {
    raw = await Promise.race([webContents.executeJavaScriptInIsolatedWorld(STORAGE_ESTIMATE_WORLD_ID, [script]), timeout])
  } catch {
    return null
  }
  // Re-checked after the await: the tab can navigate away while this was
  // in flight, and a stale answer attributed to the new origin would be
  // exactly the kind of overclaim this popover exists to avoid.
  if (typeof raw !== 'string' || webContents.isDestroyed() || originFromUrl(webContents.getURL()) !== origin) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const usageBytes = readNumber((parsed as Record<string, unknown>).usage)
  const quotaBytes = readNumber((parsed as Record<string, unknown>).quota)
  if (usageBytes === undefined || quotaBytes === undefined) return null
  return { usageBytes, quotaBytes }
}
