// The two decisions of a first visit to a published app (ADR-0074, ADR-0075), kept pure: whether an origin is
// one Orivon has never held, and whether the bundle that came down in the background is the one the site declared.

import type { BundleTree } from '../../broker/policy/bundle-hash.js'
import { ddocVerdict } from '../../trust/ddoc.js'
import type { DdocDeclaration } from '../../loader/ddoc-declaration.js'

/** What Orivon knows of an origin before a visit. */
export interface VisitState {
  readonly registered: boolean
  readonly pinned: boolean
  /** `'0.0.0'` for an origin no version was ever registered for. */
  readonly versionFloor: string
  /** The person pressed Deny on this origin's first-visit question (`./declined-apps.ts`). */
  readonly declined: boolean
}

/**
 * `first`: ask, download, verify, then enter. `declined`: the person said no, so the site is a plain
 * website and nothing here starts. `known`: an app Orivon has held before; its updates, floor and
 * re-consent follow the ordinary install path. A visit that stopped before the files were let in
 * granted nothing and recorded nothing, so it is `first` again and asks again.
 */
export function visitKind (state: VisitState): 'first' | 'declined' | 'known' {
  if (state.registered || state.pinned || state.versionFloor !== '0.0.0') return 'known'
  return state.declined ? 'declined' : 'first'
}

export type BundleJudgement =
  | { readonly kind: 'enter', readonly ddoc: 'verified' | 'not-published' }
  | { readonly kind: 'block', readonly differing: readonly string[], readonly differingCount: number, readonly rootMatches: boolean }

/**
 * Compares the files that came down with the tree the site published for them. A site that publishes
 * none, or none Orivon can read, leaves nothing to compare: the files are let in on Orivon's own
 * checks alone, which is not the same as being verified.
 */
export function judgeBundle (tree: BundleTree, declaration: Pick<DdocDeclaration, 'bundleHash' | 'leaves'> | undefined): BundleJudgement {
  const verdict = ddocVerdict({ bundleHash: tree.root, assets: tree.assets }, declaration)
  if (verdict.status === 'failed') {
    return { kind: 'block', differing: verdict.differing, differingCount: verdict.differingCount, rootMatches: verdict.rootMatches }
  }
  return { kind: 'enter', ddoc: verdict.status === 'verified' ? 'verified' : 'not-published' }
}
