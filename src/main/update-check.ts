// Update check: notifies, never installs.
//
// Owner decision (build-plan.md SS"Auto-install is cut", 2026-08-25): unsigned
// electron-updater on Linux verifies only a SHA-512 fetched from the SAME
// HOST that serves the binary, which is a standing remote-code-execution
// channel keyed to a GitHub token -- weaker than what ADR-0005 demands of
// third-party apps, which is the wrong way round for the browser's own
// binary. v0 checks and notifies, linking to the release. Signing the
// update manifest with an offline key is the post-MVP upgrade.
//
// This file therefore contains no download, no signature/hash verification,
// and no install step, anywhere. The only network call it makes is a read of
// GitHub's "latest release" metadata.
//
// STRUCTURE, innermost (pure) to outermost (real I/O): SS1's decision table,
// then SS2 composing it around an injected fetch, then SS3's real wiring --
// each section banner below says what its own layer is and is not tested.
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
// vitest merely imports this file to test the pure/injected parts above --
// the exact same erasure-by-construction principle registry.ts uses for its
// type-only `import type { App }`, extended to the values this file also
// needs for real.
import type { App } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Subsystem } from './registry.js'

// ---------------------------------------------------------------------------
// Version parsing and comparison (semver 2.0.0 subset, pure, unexported)
// ---------------------------------------------------------------------------

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: ReadonlyArray<string | number>
}

// The official semver 2.0.0 grammar
// (https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string),
// with one relaxation: an optional leading "v"/"V", because that is the
// prevailing GitHub release-tag convention (`git tag v1.2.3`) and rejecting
// it would make every real tag "malformed". Build metadata is captured but
// deliberately never used below -- semver spec item 10 excludes it from
// precedence entirely.
const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/i

/** Malformed input (anything not matching the grammar above) returns null -- never throws. */
function parseVersion (raw: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(raw.trim())
  if (match === null) return null

  const majorStr = match[1]
  const minorStr = match[2]
  const patchStr = match[3]
  const prereleaseStr = match[4]
  // The three numeric groups are mandatory in the pattern (never inside a
  // `?` quantifier), so a successful match always populates them. This
  // check exists for noUncheckedIndexedAccess, not a real runtime case.
  if (majorStr === undefined || minorStr === undefined || patchStr === undefined) return null

  const prerelease = prereleaseStr === undefined || prereleaseStr === ''
    ? []
    : prereleaseStr.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))

  return { major: Number(majorStr), minor: Number(minorStr), patch: Number(patchStr), prerelease }
}

/**
 * Semver 2.0.0 precedence (https://semver.org/#spec-item-11).
 * Returns <0, 0 or >0 like Array#sort's comparator.
 */
function compareVersions (a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch

  const aHasPre = a.prerelease.length > 0
  const bHasPre = b.prerelease.length > 0
  if (aHasPre !== bHasPre) return aHasPre ? -1 : 1
  if (!aHasPre) return 0

  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1 // fewer fields sorts lower
    if (y === undefined) return 1
    if (x === y) continue
    const xIsNum = typeof x === 'number'
    const yIsNum = typeof y === 'number'
    if (xIsNum && yIsNum) return x - y
    if (xIsNum !== yIsNum) return xIsNum ? -1 : 1 // numeric < alphanumeric
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// 1. The pure decision table
// ---------------------------------------------------------------------------

export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // once a day

export interface DecideUpdateNoticeInput {
  readonly currentVersion: string
  /** Omit when this call is only asking "is a check due" (see shouldCheck). */
  readonly latestVersion?: string
  readonly lastNotifiedVersion?: string
  /** Epoch ms of the last network attempt, or undefined if never checked. */
  readonly lastCheckedAt?: number
  /** Epoch ms "now", injected so this stays pure. */
  readonly now: number
  readonly checkIntervalMs?: number
}

export interface UpdateNoticeDecision {
  /** Whether the caller should perform the network fetch now (throttle gate). */
  readonly shouldCheck: boolean
  /** Whether the caller should show a notification. */
  readonly shouldNotify: boolean
  /** The version to notify about, or null when shouldNotify is false. */
  readonly notifyVersion: string | null
}

/**
 * Pure. No network, no filesystem, no Electron -- see the file header for
 * why that erasure is load-bearing, not just tidy.
 *
 * Called in two shapes by checkForUpdate below:
 *   - WITHOUT latestVersion, to decide whether a check is even due
 *     (shouldCheck only -- shouldNotify is always false in this shape).
 *   - WITH latestVersion, after a fetch, to decide whether to notify.
 * Both shapes go through the same function so there is exactly one place
 * that encodes "what counts as due" and "what counts as newer".
 */
export function decideUpdateNotice (input: DecideUpdateNoticeInput): UpdateNoticeDecision {
  const checkIntervalMs = input.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
  const shouldCheck = input.lastCheckedAt === undefined ||
    input.now - input.lastCheckedAt >= checkIntervalMs

  const nothingToNotify: UpdateNoticeDecision = { shouldCheck, shouldNotify: false, notifyVersion: null }

  // No fetched candidate this call (a pre-check throttle read, or a fetch
  // that failed upstream) -- nothing to compare, so nothing to notify.
  if (input.latestVersion === undefined) return nothingToNotify

  const current = parseVersion(input.currentVersion)
  const latest = parseVersion(input.latestVersion)
  // Fail safe: either side unparsable means "newer" can never be established
  // safely, so the safe default -- never notify -- wins. This also protects
  // against a garbled or unexpected-shape response for `latest`.
  if (current === null || latest === null) return nothingToNotify

  // Same or older than what's already running: silent. This is the rule
  // that makes a downgrade (a bad/rolled-back release, a stale cache, a
  // pre-release compared against the stable version already installed)
  // silent rather than a wrong notification.
  if (compareVersions(latest, current) <= 0) return nothingToNotify

  if (input.lastNotifiedVersion !== undefined) {
    const notified = parseVersion(input.lastNotifiedVersion)
    // Compared as parsed versions, not raw strings, so a "v" prefix or
    // build-metadata difference between what was stored and what was just
    // fetched does not cause a spurious re-notification. An unparsable
    // stored value is ignored (treated as "nothing recorded") rather than
    // blocking a real notification.
    if (notified !== null && compareVersions(notified, latest) === 0) return nothingToNotify
  }

  return { shouldCheck, shouldNotify: true, notifyVersion: input.latestVersion }
}

// ---------------------------------------------------------------------------
// 2. checkForUpdate -- composes the decision table around an injected fetch
// ---------------------------------------------------------------------------

export interface ReleaseInfo {
  /** Raw version/tag as reported by the source, e.g. "v1.2.3". */
  readonly version: string
  /** Link to the release page, to hand the user -- never a download URL. */
  readonly url: string
}

/** Returns null on any failure (offline, no releases yet, bad response) -- never throws by contract, but see checkForUpdate's own safety net below. */
export type FetchLatestRelease = () => Promise<ReleaseInfo | null>

export interface CheckForUpdateInput {
  readonly currentVersion: string
  readonly now: number
  readonly lastCheckedAt?: number
  readonly lastNotifiedVersion?: string
  readonly checkIntervalMs?: number
  readonly fetchLatestRelease: FetchLatestRelease
}

export interface CheckForUpdateResult {
  /** Whether a network attempt actually happened this call (vs. throttled). */
  readonly checkedNow: boolean
  readonly shouldNotify: boolean
  readonly notifyVersion: string | null
  readonly release: ReleaseInfo | null
}

/**
 * `fetchLatestRelease` is a parameter, so this is exercised in tests with a
 * stub. Real wiring (below) supplies the GitHub-backed implementation.
 */
export async function checkForUpdate (input: CheckForUpdateInput): Promise<CheckForUpdateResult> {
  const base = {
    currentVersion: input.currentVersion,
    now: input.now,
    ...(input.lastCheckedAt !== undefined ? { lastCheckedAt: input.lastCheckedAt } : {}),
    ...(input.lastNotifiedVersion !== undefined ? { lastNotifiedVersion: input.lastNotifiedVersion } : {})
  }

  const gate = decideUpdateNotice({
    ...base,
    ...(input.checkIntervalMs !== undefined ? { checkIntervalMs: input.checkIntervalMs } : {})
  })
  if (!gate.shouldCheck) {
    return { checkedNow: false, shouldNotify: false, notifyVersion: null, release: null }
  }

  // Defensive even though FetchLatestRelease's contract says "never throws":
  // the real implementation below is careful to honour that, but this
  // orchestrator must not let a THIRD-PARTY-INJECTED implementation (e.g. in
  // a future caller) take the app down over a background, best-effort check.
  const release = await input.fetchLatestRelease().catch(() => null)

  const final = decideUpdateNotice({
    ...base,
    ...(release !== null ? { latestVersion: release.version } : {})
  })

  return { checkedNow: true, shouldNotify: final.shouldNotify, notifyVersion: final.notifyVersion, release }
}

// ---------------------------------------------------------------------------
// 3. Real wiring: persistence, the GitHub fetch, and the notification.
//    Untested by design -- see the file header.
// ---------------------------------------------------------------------------

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
 *   import { updateCheckSubsystem } from './update-check.js'
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
