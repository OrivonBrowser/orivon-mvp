// What the Settings page is told about updates: what the last look found, whether this copy can install it, and how
// the install is going. Pure; the page reads it as `updates.changed` and in the reply to "Check now".
import type { FlowState, Installability } from './update-flow.js'
import type { ReleaseInfo } from './update-check.js'

export interface UpdateAnswer {
  /** False when the release list could not be read, or has no signed release. */
  readonly reached: boolean
  readonly current: string
  /** The tag of the newer release on offer, e.g. `v1.2.0`; null when there is none. */
  readonly latest: string | null
  readonly newer: boolean
  /** The release page, built from known parts, never taken from the response. */
  readonly url: string | null
  /** Whether Install is offered: the release has a package for this copy and this copy can replace itself. */
  readonly canInstall: boolean
  /** Why not, in a sentence, when `newer` and not `canInstall`. */
  readonly cannotInstallWhy: string | null
  readonly phase: FlowState['phase']
  readonly percent: number | null
  readonly failure: string | null
}

export interface AnswerParts {
  readonly current: string
  /** The release on offer, if any. */
  readonly release: ReleaseInfo | null
  readonly installability: Installability | null
  readonly flow: FlowState
  /** Whether the last look reached the release source; only read while no release is on offer. */
  readonly reached: boolean
}

export function buildAnswer ({ current, release, installability, flow, reached }: AnswerParts): UpdateAnswer {
  const live = { phase: flow.phase, percent: flow.percent, failure: flow.failure }
  if (release === null) return { reached, current, latest: null, newer: false, url: null, canInstall: false, cannotInstallWhy: null, ...live }
  return {
    reached: true,
    current,
    latest: release.version,
    newer: true,
    url: release.url,
    canInstall: installability?.ok === true,
    cannotInstallWhy: installability?.ok === false ? installability.why : null,
    ...live
  }
}
