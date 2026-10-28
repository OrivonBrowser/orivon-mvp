// When a newer release is found and when the person is told: the look once a day, the release kept until the
// running version catches up, and the question asked once per version in a window in use. The state file, the source
// and the asking come in, so what the rules decide is tested without a disk or a window.
import { compareVersions, parseVersion } from './github-release-version.js'
import { releaseUrl } from './release-url.js'
import { checkForUpdate, decideUpdateNotice } from './update-check.js'
import type { FetchLatestRelease, ReleaseInfo } from './update-check.js'

export interface NoticeState {
  /** When a look last reached the release list. */
  readonly lastCheckedAt?: number
  /** The newest release that look found, while it is newer than the running version. */
  readonly lastFoundVersion?: string
  /** The release the person has been told about, in a window or in Settings. */
  readonly lastNotifiedVersion?: string
}

/** A window in use to ask in, or the reason there is none yet. */
export type PlaceResult<Place> = { readonly place: Place } | { readonly waiting: string }

/** How an ask ended: `seen` is false when the question closed before it was drawn, so the person never read it. */
export interface AskOutcome {
  readonly seen: boolean
}

/** What Settings is told: the answer of the last look, as words. */
export interface UpdateAnswer {
  /** False when the latest release could not be read: offline, or none published. */
  readonly reached: boolean
  readonly current: string
  readonly latest: string | null
  readonly newer: boolean
  /** The release page, built from known parts, never taken from the response. */
  readonly url: string | null
}

/** A newer release than the running one, found and not yet installed. */
export interface UpdateOffer {
  readonly current: string
  /** The tag. */
  readonly latest: string
  readonly url: string
  /** Not yet shown to the person in a window or in Settings. */
  readonly pending: boolean
}

export interface NoticeDeps<Place> {
  readonly currentVersion: string
  readonly now: () => number
  readonly read: () => Promise<NoticeState>
  readonly write: (state: NoticeState) => Promise<void>
  readonly fetchLatest: FetchLatestRelease
  /** Where to ask now. Never an operating-system box: no place means no question. */
  readonly place: () => PlaceResult<Place>
  /** Shows the question and resolves once the person has answered it or it was closed. */
  readonly ask: (place: Place, release: ReleaseInfo) => Promise<AskOutcome>
  readonly log: (line: string) => void
}

export interface UpdateNotice {
  /** The scheduled look: throttled to once a day, then starts the question if a release is waiting, without waiting for the answer. Never rejects. */
  readonly runScheduled: () => Promise<void>
  /** Asks if a release is waiting and there is a window in use. Never rejects. */
  readonly tryAsk: () => Promise<void>
  /** "Check now": looks whatever was asked last, keeps what it finds on offer and counts it as told. */
  readonly checkNow: () => Promise<UpdateAnswer>
  readonly offer: () => UpdateOffer | null
  /** Calls `listener` when the offer or whether it is still to be shown changes; answers the removal. */
  readonly onChange: (listener: (offer: UpdateOffer | null) => void) => () => void
}

/** Whether `tag` is a version newer than the running one. */
function isNewer (current: string, tag: string): boolean {
  return decideUpdateNotice({ currentVersion: current, latestVersion: tag, now: 0 }).shouldNotify
}

/**
 * Whether the person was told about `tag` or a newer release, by parsed value so a `v` does not matter. A release
 * pulled back leaves the told version above the newest one, and that newer release is still the one they know of.
 */
function isTold (told: string | undefined, tag: string): boolean {
  const a = told === undefined ? null : parseVersion(told)
  const b = parseVersion(tag)
  return a !== null && b !== null && compareVersions(a, b) >= 0
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200)

/** A question that closed before it was drawn is asked again this many times, then waits for the next look. */
const UNSEEN_ASKS = 3

export function createUpdateNotice<Place> (deps: NoticeDeps<Place>): UpdateNotice {
  const current = deps.currentVersion
  let loaded = false
  let state: NoticeState = {}
  /** The tag of the newest release newer than the running one. */
  let found: string | null = null
  let inFlight = false
  /** Set when a question could not be shown: it is not tried again until the next look. */
  let broken = false
  /** Questions in a row that closed before they were drawn. */
  let unseen = 0
  let lastWait: string | undefined
  const listeners = new Set<(offer: UpdateOffer | null) => void>()

  const offer = (): UpdateOffer | null =>
    found === null ? null : { current, latest: found, url: releaseUrl(found), pending: !isTold(state.lastNotifiedVersion, found) }

  const sameOffer = (a: UpdateOffer | null, b: UpdateOffer | null): boolean => a?.latest === b?.latest && a?.pending === b?.pending

  /** Runs `change`, then tells the listeners if the offer is not what it was. */
  const changing = async (change: () => Promise<void> | void): Promise<void> => {
    const before = offer()
    try {
      await change()
    } finally {
      const after = offer()
      if (!sameOffer(before, after)) for (const listener of listeners) listener(after)
    }
  }

  /** Where the last write ends: the next one starts after it, so the state file is never written by two at once. */
  let writing: Promise<void> = Promise.resolve()

  /** Writes `state` as it is when this write's turn comes, so the last write carries the newest. A write that fails is logged and never blocks the next. */
  const persist = async (): Promise<void> => {
    writing = writing.then(async () => {
      try {
        await deps.write(state)
      } catch (error) {
        deps.log(`could not remember the update state: ${reasonOf(error)}`)
      }
    })
    await writing
  }

  /** The state to keep: the found and told versions as they are now, and the look's time (`checkedAt`, else the one kept). */
  const stateWith = (checkedAt: number | undefined): NoticeState => {
    const lastCheckedAt = checkedAt ?? state.lastCheckedAt
    return {
      ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
      ...(found !== null ? { lastFoundVersion: found } : {}),
      ...(state.lastNotifiedVersion !== undefined ? { lastNotifiedVersion: state.lastNotifiedVersion } : {})
    }
  }

  /** The window to ask in. A throw while looking (a tab's contents torn down under the window) is a wait, not a failure. */
  const placeNow = (): PlaceResult<Place> => {
    try {
      return deps.place()
    } catch (error) {
      return { waiting: `could not tell which window is in use: ${reasonOf(error)}` }
    }
  }

  /** Counts `tag` as told, unless a newer release was told meanwhile: the told version never moves back. */
  const markTold = (tag: string): void => {
    const kept = state.lastNotifiedVersion === undefined ? null : parseVersion(state.lastNotifiedVersion)
    const next = parseVersion(tag)
    if (kept !== null && next !== null && compareVersions(kept, next) > 0) return
    state = { ...state, lastNotifiedVersion: tag }
  }

  /** Reads the file once; a release it names is on offer again only while it is newer than the running version. */
  const load = async (): Promise<void> => {
    if (loaded) return
    state = await deps.read()
    loaded = true
    found = state.lastFoundVersion !== undefined && isNewer(current, state.lastFoundVersion) ? state.lastFoundVersion : null
  }

  /** What a look that reached the release list found. */
  const adopt = (release: ReleaseInfo | null): void => {
    found = release !== null && isNewer(current, release.version) ? release.version : null
    if (found !== null) deps.log(`release found: ${found}`)
  }

  const tryAsk = async (): Promise<void> => {
    if (inFlight || broken) return
    const shown = offer()
    if (shown === null || !shown.pending) return
    const where = placeNow()
    if ('waiting' in where) {
      if (lastWait !== where.waiting) deps.log(`waiting for a window in use: ${where.waiting}`)
      lastWait = where.waiting
      return
    }
    lastWait = undefined
    inFlight = true
    try {
      await changing(async () => {
        deps.log(`asking about ${shown.latest}`)
        const { seen } = await deps.ask(where.place, { version: shown.latest, url: shown.url })
        if (!seen) {
          unseen += 1
          if (unseen >= UNSEEN_ASKS) broken = true
          deps.log(`the question about ${shown.latest} closed before it was shown${broken ? '; not asking again until the next look' : ''}`)
          return
        }
        unseen = 0
        markTold(shown.latest)
        state = stateWith(undefined)
        await persist()
      })
    } catch (error) {
      broken = true
      deps.log(`could not ask about ${shown.latest}: ${reasonOf(error)}`)
    } finally {
      inFlight = false
    }
  }

  return {
    offer,
    tryAsk,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    runScheduled: async () => {
      try {
        await changing(async () => {
          await load()
          broken = false
          unseen = 0
          const now = deps.now()
          const result = await checkForUpdate({
            currentVersion: current,
            now,
            ...(state.lastCheckedAt !== undefined ? { lastCheckedAt: state.lastCheckedAt } : {}),
            fetchLatestRelease: deps.fetchLatest
          })
          if (!result.checkedNow) return
          if (!result.reached) {
            deps.log(`could not reach the release list: ${result.failure ?? 'no reason given'}`)
            return
          }
          deps.log(`checked: newest ${result.release?.version ?? 'none'}, running ${current}`)
          adopt(result.release)
          state = stateWith(now)
          await persist()
        })
        // Not awaited: the question can stay open for hours, and the next look must not wait behind it.
        tryAsk().catch((error: unknown) => { deps.log(`the question failed: ${reasonOf(error)}`) })
      } catch (error) {
        deps.log(`the update check failed: ${reasonOf(error)}`)
      }
    },
    checkNow: async () => {
      let answer: UpdateAnswer = { reached: false, current, latest: null, newer: false, url: null }
      try {
        await changing(async () => {
          await load()
          const result = await checkForUpdate({ currentVersion: current, now: deps.now(), fetchLatestRelease: deps.fetchLatest })
          if (!result.reached) {
            deps.log(`could not reach the release list: ${result.failure ?? 'no reason given'}`)
            return
          }
          adopt(result.release)
          // The person is reading it in Settings: a question about it would only repeat what they just read.
          if (found !== null) markTold(found)
          state = stateWith(undefined)
          await persist()
          answer = { reached: result.release !== null, current, latest: result.release?.version ?? null, newer: found !== null, url: result.release === null ? null : releaseUrl(result.release.version) }
        })
      } catch (error) {
        deps.log(`the update check failed: ${reasonOf(error)}`)
      }
      return answer
    }
  }
}
