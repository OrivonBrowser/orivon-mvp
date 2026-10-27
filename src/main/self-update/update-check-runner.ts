// Real wiring for ./update-notice.ts: the state file, the GitHub fetch and the window the question is asked in.
// Untested by design: everything with a decision to get right is in the pure and injected modules beside it.
//
// `net` is imported dynamically inside the fetch: a top-level static value import from 'electron' is silently
// broken under this repo's vitest (the package's entry point outside a real Electron process is a string), and
// this file has no test importing it.
import type { App } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomicAsync } from '../../broker/adapters/atomic-write.js'
import { ownFetch } from '../route/own-requests.js'
import type { WindowRegistry } from '../shell/window-registry.js'
import { pickNewestRelease } from './newest-release.js'
import { GITHUB_OWNER, GITHUB_REPO, releaseUrl } from './release-url.js'
import type { ReleaseInfo } from './update-check.js'
import { createUpdateNotice } from './update-notice.js'
import type { NoticeState, UpdateNotice } from './update-notice.js'
import { testUpdateFetch } from './update-test-seam.js'
import { askInWindow, updatePlace } from './update-window.js'

// The repository is spelled out as constants (./release-url.ts) rather than
// parsed from package.json at runtime: a runtime parse of a free-text git URL
// would add a failure mode (a reformatted field silently breaking the update
// check) for no benefit.
// The list, not `/releases/latest`: that endpoint never answers a pre-release, and every release here is one.
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=10`
const FETCH_TIMEOUT_MS = 10_000

const statePath = (app: App): string => join(app.getPath('userData'), 'update-check-state.json')

/** Missing file (first run) or corrupt JSON both read back as "never checked" -- fail safe, never throw. */
async function readState (path: string): Promise<NoticeState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const obj = parsed as Record<string, unknown>
    return {
      ...(typeof obj['lastCheckedAt'] === 'number' ? { lastCheckedAt: obj['lastCheckedAt'] } : {}),
      ...(typeof obj['lastFoundVersion'] === 'string' ? { lastFoundVersion: obj['lastFoundVersion'] } : {}),
      ...(typeof obj['lastNotifiedVersion'] === 'string' ? { lastNotifiedVersion: obj['lastNotifiedVersion'] } : {})
    }
  } catch {
    return {}
  }
}

/**
 * The one function in this module that touches the network, and it only
 * ever reads metadata -- see ./update-check.ts.
 *
 * Uses Electron's net.fetch (Chromium's network stack, session-aware) rather
 * than Node's global fetch, per Electron's own guidance for main-process
 * requests. Imported dynamically -- see the file header.
 */
async function fetchLatestGithubRelease (): Promise<ReleaseInfo | null> {
  const { net } = await import('electron')

  // Offline, a DNS failure or a timeout rejects: the source was not reached, and the check is not recorded.
  // Through the tunnel while the whole browser is on it, or not at all.
  const response = await ownFetch(async (url, init) => await net.fetch(url, init))(RELEASES_API, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `${GITHUB_REPO}-update-check`
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })

  // A 404 is "nothing to report", not an error. Any other refusal (a rate limit, a server error) is not an answer.
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`the release source answered ${String(response.status)}`)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null // malformed JSON: fail safe, never crash the app over this
  }

  const newest = pickNewestRelease(body)
  if (newest === null) return null

  // Built from the known repo constants plus the tag name, NOT taken from the response's `html_url`: that is
  // untrusted network input, and a tag that looks like a version needs no further check.
  return { version: newest.tag, url: releaseUrl(newest.tag) }
}

/** The one update notice of a process: Settings reads its offer, the schedule runs it, and the question is asked in the window in use. */
export function createBrowserUpdate (options: { app: App, windows: Pick<WindowRegistry, 'focused'>, kiosk: boolean }): UpdateNotice {
  const { app, windows, kiosk } = options
  const path = statePath(app)
  const log = (line: string): void => { console.log(`[self-update] ${line}`) }
  return createUpdateNotice({
    currentVersion: app.getVersion(),
    now: Date.now,
    read: async () => await readState(path),
    write: async (state) => { await writeFileAtomicAsync(path, JSON.stringify(state)) },
    fetchLatest: testUpdateFetch() ?? fetchLatestGithubRelease,
    place: () => updatePlace(windows, kiosk),
    ask: async (place, release) => { await askInWindow(place, release, app.getVersion(), log) },
    log
  })
}
