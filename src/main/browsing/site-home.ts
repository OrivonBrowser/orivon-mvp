// Where the content shown at an address says it lives (ADR-0056). An installed app's pin holds
// its manifest; other content has one only at its root CID, read only when a provider judged
// the content Level 3 or 4, because only then does the answer decide anything.

import type { PinRecord } from '../../broker/policy/pin.js'
import type { Loader } from '../../loader/index.js'
import type { ProviderVerdict } from '../../trust/score-provider.js'
import type { HomeFacts } from '../../trust/domain-binding.js'
import type { ManifestAtRoot } from '../../loader/fetch/manifest-at-root.js'
import { homeAt } from './site-trust.js'
import type { Home } from './site-trust.js'

export type HomeSource = Pick<Loader, 'manifestFor' | 'manifestAt'>

/** A judged level worth binding: Level 3 or 4, the only ones that change what is shown. */
function judgedAbove2 (verdict: ProviderVerdict): boolean {
  return verdict.status === 'judged' && verdict.evaluation.trustlessity.level >= 3
}

/**
 * `liveCid` is the root of the content shown now, when it came from IPFS. Never throws: a read
 * that fails, or does not answer within `waitMs`, binds nothing, and is marked `pending` in the
 * second case so a caller asks again.
 */
export async function readHome (source: HomeSource, origin: string, pin: PinRecord | null, liveCid: string | undefined, verdict: ProviderVerdict, waitMs: number): Promise<Home> {
  if (pin !== null) {
    const pinned = await source.manifestFor(origin).catch(() => undefined)
    return homeAt(origin, pinned === undefined ? { kind: 'unread' } : { kind: 'app', domain: pinned.domain })
  }
  if (liveCid === undefined) return homeAt(origin, { kind: 'website' })
  return await readHomeAtRoot(source.manifestAt, origin, liveCid, verdict, waitMs)
}

/**
 * The home of the content `cid` names, seen from `origin`: the manifest at that root, read only
 * when `verdict` is a judged Level 3 or 4. The page lookup (`page-score-lookup.ts`) asks the same
 * question about an address that is not open in a tab, so both surfaces bind a judged level alike.
 */
export async function readHomeAtRoot (manifestAt: HomeSource['manifestAt'], origin: string, cid: string, verdict: ProviderVerdict, waitMs: number): Promise<Home> {
  if (!judgedAbove2(verdict)) return homeAt(origin, { kind: 'website' })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'late'>((resolve) => { timer = setTimeout(() => { resolve('late') }, waitMs) })
  try {
    const read: ManifestAtRoot | 'late' = await Promise.race([manifestAt(origin, cid), timeout])
    if (read === 'late') return homeAt(origin, { kind: 'unread' }, true)
    const facts: HomeFacts = read.kind === 'app' ? { kind: 'app', domain: read.manifest.domain } : read.kind === 'website' ? { kind: 'website' } : { kind: 'unread' }
    return homeAt(origin, facts)
  } catch {
    return homeAt(origin, { kind: 'unread' })
  } finally {
    clearTimeout(timer)
  }
}
