// When and how the check asks: once a day on a schedule, at once on request, and the question once per version. The
// state file, the source and the asking come in, so what the rules decide is tested without a disk or a window.
import { checkForUpdate } from './update-check.js'
import type { CheckForUpdateResult, FetchLatestRelease, ReleaseInfo } from './update-check.js'

export interface CheckerState {
  readonly lastCheckedAt?: number
  readonly lastNotifiedVersion?: string
}

export interface CheckerDeps {
  readonly currentVersion: string
  readonly now: () => number
  readonly read: () => Promise<CheckerState>
  readonly write: (state: CheckerState) => Promise<void>
  readonly fetchLatest: FetchLatestRelease
  /** Tells the install flow which release is on offer (null: none). */
  readonly offer: (release: ReleaseInfo | null) => Promise<void>
  /** Asks the person about `release` where they are working. False when there was no place to ask yet. */
  readonly ask: (release: ReleaseInfo) => Promise<boolean>
}

export interface UpdateChecker {
  /** The scheduled look: throttled to once a day, and it asks at most once per version. Never rejects. */
  readonly runScheduled: () => Promise<void>
  /** "Check now": asks the release source whatever was asked last; asks the person nothing and records nothing. */
  readonly checkNow: () => Promise<CheckForUpdateResult>
}

export function createUpdateChecker (deps: CheckerDeps): UpdateChecker {
  /** A release found but not yet asked about, because no window was in use: asked again at the next look, without asking the network. */
  let waiting: ReleaseInfo | null = null

  const askAndRecord = async (release: ReleaseInfo, checkedAt: number): Promise<void> => {
    if (!await deps.ask(release)) { waiting = release; return }
    waiting = null
    await deps.write({ lastCheckedAt: checkedAt, lastNotifiedVersion: release.version })
  }

  return {
    runScheduled: async () => {
      try {
        const state = await deps.read()
        if (waiting !== null) { await askAndRecord(waiting, deps.now()); return }
        const now = deps.now()
        const result = await checkForUpdate({
          currentVersion: deps.currentVersion,
          now,
          ...(state.lastCheckedAt !== undefined ? { lastCheckedAt: state.lastCheckedAt } : {}),
          ...(state.lastNotifiedVersion !== undefined ? { lastNotifiedVersion: state.lastNotifiedVersion } : {}),
          fetchLatestRelease: deps.fetchLatest
        })
        // Throttled, or the source was not reached: nothing changes, so the next look tries again.
        if (!result.checkedNow || !result.reached) return
        if (result.shouldNotify && result.release !== null) {
          await deps.offer(result.release)
          // Until the person has been asked, the day's check is not recorded: a restart looks again.
          await askAndRecord(result.release, now)
          return
        }
        await deps.write({ ...state, lastCheckedAt: now })
      } catch (error) {
        console.error('[orivon] the update check failed:', error)
      }
    },
    checkNow: async () => {
      const result = await checkForUpdate({ currentVersion: deps.currentVersion, now: deps.now(), fetchLatestRelease: deps.fetchLatest })
      await deps.offer(result.shouldNotify ? result.release : null)
      return result
    }
  }
}
