// Real wiring for ./update-check.ts: persistence, the GitHub fetch, and the
// notification. Split out of that file (Rule 2, docs/development/code-
// guidelines.md). Untested by design (same as window.ts/ipc.ts/index.ts) --
// everything with a decision to get right lives in the two pure/injected
// functions in ./update-check.ts, which ARE tested.
//
// WHY THE ELECTRON IMPORT BELOW IS `import type`, AND WHY REAL ELECTRON
// VALUES (Notification/net/shell) ARE IMPORTED DYNAMICALLY INSIDE THE
// FUNCTIONS THAT USE THEM, NOT STATICALLY AT THE TOP:
// Outside a real Electron process (i.e. under vitest, which runs this file
// in plain Node), the `electron` npm package's entry point is
// `module.exports = getElectronPath()` -- a STRING (the path to the binary),
// computed by calling a function, not a static object. A top-level
// `import { Notification, net, shell } from 'electron'` was verified
// (2026-08-26) to not throw under this repo's vitest, but only because
// Vite/esbuild's loose CJS interop silently destructures `undefined` off
// that string for every named binding -- an accident of the current
// toolchain's interop strategy, not a guarantee, and the resulting bindings
// would be silently broken for the whole lifetime of the module. A dynamic
// `import('electron')` INSIDE a function body is never reached at all while
// vitest merely imports this file to test the pure/injected parts in
// ./update-check.ts -- the exact same erasure-by-construction principle
// registry.ts uses for its type-only `import type { App }`, extended to the
// values this file also needs for real.
import type { App } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Subsystem } from './registry.js'
import { checkForUpdate, type ReleaseInfo } from './update-check.js'

// package.json's repository field, spelled out as constants rather than
// parsed from it at runtime: this is the one place they are needed, and a
// runtime parse of a free-text git URL would add a failure mode (a
// reformatted field silently breaking the update check) for no benefit over
// two constants next to the fetch that uses them.
const GITHUB_OWNER = 'OrivonBrowser'
const GITHUB_REPO = 'orivon-mvp'
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
const FETCH_TIMEOUT_MS = 10_000

interface PersistedState {
  readonly lastCheckedAt?: number
  readonly lastNotifiedVersion?: string
}

function statePath (app: App): string {
  // app.getPath('userData') is the ADR-0003-sanctioned storage root -- never
  // a hardcoded XDG/$HOME path (the hookify warn-hardcoded-user-paths rule).
  return join(app.getPath('userData'), 'update-check-state.json')
}

/** Missing file (first run) or corrupt JSON both read back as "never checked" -- fail safe, never throw. */
async function readState (path: string): Promise<PersistedState> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const obj = parsed as Record<string, unknown>
    const lastCheckedAt = typeof obj.lastCheckedAt === 'number' ? obj.lastCheckedAt : undefined
    const lastNotifiedVersion = typeof obj.lastNotifiedVersion === 'string' ? obj.lastNotifiedVersion : undefined
    return {
      ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
      ...(lastNotifiedVersion !== undefined ? { lastNotifiedVersion } : {})
    }
  } catch {
    return {}
  }
}

/** Best effort: losing this write only costs one extra check next launch, not worth crashing over. */
async function writeState (path: string, state: PersistedState): Promise<void> {
  try {
    await writeFile(path, JSON.stringify(state), 'utf8')
  } catch (error) {
    console.error('[orivon] update-check: failed to persist state:', error)
  }
}

/**
 * The one function in this module that touches the network, and it only
 * ever reads metadata -- see the file header.
 *
 * Uses Electron's net.fetch (Chromium's network stack, session-aware) rather
 * than Node's global fetch, per Electron's own guidance for main-process
 * requests (verified via context7 2026-08-26). Imported dynamically -- see
 * the file header.
 */
async function fetchLatestGithubRelease (): Promise<ReleaseInfo | null> {
  const { net } = await import('electron')

  let response: Awaited<ReturnType<typeof net.fetch>>
  try {
    response = await net.fetch(RELEASES_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `${GITHUB_REPO}-update-check`
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  } catch {
    return null // offline, DNS failure, timeout -- silently skip this check
  }

  // A repository with no releases yet -- true for this one today -- 404s.
  // That is "nothing to report", not an error.
  if (!response.ok) return null

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null // malformed JSON: fail safe, never crash the app over this
  }

  if (typeof body !== 'object' || body === null) return null
  const tagName = (body as Record<string, unknown>).tag_name
  if (typeof tagName !== 'string' || tagName.length === 0) return null

  return {
    version: tagName,
    // Built from the known repo constants plus the tag name, NOT taken from
    // the response's `html_url`. `html_url` is untrusted network input that
    // would otherwise need validating before ever reaching
    // shell.openExternal; constructing the URL ourselves from a tag that
    // decideUpdateNotice has already confirmed is version-shaped removes
    // that trust requirement rather than adding a check for it.
    url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${encodeURIComponent(tagName)}`
  }
}

/** Native OS notification. No-op if the platform does not support them (e.g. a headless CI box). */
async function notifyUpdateAvailable (release: ReleaseInfo): Promise<void> {
  const { Notification, shell } = await import('electron')
  if (!Notification.isSupported()) return

  const notification = new Notification({
    title: 'Orivon update available',
    body: `Version ${release.version} is available. Click to view the release.`
  })
  notification.on('click', () => {
    // Not just `void` -- that silences the floating-promise lint concern but
    // does NOT stop a rejection (openExternal can reject, e.g. no default
    // handler registered for https: on a bare Linux install) from surfacing
    // as an unhandled rejection at the process level.
    shell.openExternal(release.url).catch((error) => {
      console.error('[orivon] update-check: failed to open release URL:', error)
    })
  })
  notification.show()
}

/**
 * Exported for src/main/subsystems.ts to call directly if the two-line
 * append (see updateCheckSubsystem below) is not what the integrator wants.
 */
export async function runUpdateCheck (app: App, now: number = Date.now()): Promise<void> {
  const path = statePath(app)
  const state = await readState(path)

  const result = await checkForUpdate({
    currentVersion: app.getVersion(),
    now,
    ...(state.lastCheckedAt !== undefined ? { lastCheckedAt: state.lastCheckedAt } : {}),
    ...(state.lastNotifiedVersion !== undefined ? { lastNotifiedVersion: state.lastNotifiedVersion } : {}),
    fetchLatestRelease: fetchLatestGithubRelease
  })

  if (!result.checkedNow) return // throttled: state is unchanged, nothing to persist

  const nextState: PersistedState = {
    lastCheckedAt: now,
    ...(result.shouldNotify && result.notifyVersion !== null
      ? { lastNotifiedVersion: result.notifyVersion }
      : (state.lastNotifiedVersion !== undefined ? { lastNotifiedVersion: state.lastNotifiedVersion } : {}))
  }
  await writeState(path, nextState)

  if (result.shouldNotify && result.release !== null) {
    await notifyUpdateAvailable(result.release)
  }
}

/**
 * NOT wired into src/main/subsystems.ts by this change -- that file's
 * append point is out of scope for this stream by task boundary, left for
 * the integrator. Shaped as a ready-to-append Subsystem so doing so is
 * exactly the two lines subsystems.ts's own comment promises:
 *
 *   import { updateCheckSubsystem } from './update-check-runner.js'
 *   ... and add `updateCheckSubsystem` to the array.
 */
export const updateCheckSubsystem: Subsystem = {
  name: 'update-check',
  afterReady: (ctx) => {
    // Deliberately NOT awaited. runAfterReady (registry.ts) awaits every
    // subsystem in order before the shell window is created; this
    // subsystem has no init-order dependency for anything else in the app,
    // and awaiting a GitHub round trip (or a full network timeout while
    // offline) here would add that latency to every single launch's
    // time-to-window for a feature that is allowed to finish seconds late,
    // or not at all.
    //
    // Because it is detached, runAfterReady's try/catch does NOT cover it
    // (it only covers what afterReady itself returns/throws synchronously,
    // and this returns undefined immediately) -- so this subsystem must
    // catch its own errors, or a rejection here becomes an unhandled
    // promise rejection at the process level instead of a reported
    // subsystem failure.
    void runUpdateCheck(ctx.app).catch((error) => {
      console.error('[orivon] subsystem "update-check" failed:', error)
    })
  }
}
