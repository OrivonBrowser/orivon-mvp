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
// then SS2 composing it around an injected fetch -- both here and both
// tested. The real wiring (persistence, the GitHub fetch, the notification)
// is ./update-check-runner.ts, untested by design; the semver subset is
// ./github-release-version.ts. Split across three files (Rule 2,
// docs/development/code-guidelines.md).

import { compareVersions, parseVersion } from './github-release-version.js'

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
 * stub. Real wiring (./update-check-runner.ts) supplies the GitHub-backed
 * implementation.
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
