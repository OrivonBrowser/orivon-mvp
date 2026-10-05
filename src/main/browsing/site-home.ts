// Where the content shown at an address says it lives (ADR-0055). An installed app's pin holds
// its manifest; other content has one only at its root CID, read only when a provider judged
// the content Level 3 or 4, because only then does the answer decide anything.

import type { PinRecord } from '../../broker/policy/pin.js'
import type { Loader } from '../../loader/index.js'
import type { ProviderVerdict } from '../../trust/score-provider.js'
import type { HomeFacts } from '../../trust/domain-binding.js'
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
  if (liveCid === undefined || !judgedAbove2(verdict)) return homeAt(origin, { kind: 'website' })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'late'>((resolve) => { timer = setTimeout(() => { resolve('late') }, waitMs) })
  try {
    const read = await Promise.race([source.manifestAt(origin, liveCid), timeout])
    if (read === 'late') return homeAt(origin, { kind: 'unread' }, true)
    const facts: HomeFacts = read.kind === 'app' ? { kind: 'app', domain: read.manifest.domain } : read.kind === 'website' ? { kind: 'website' } : { kind: 'unread' }
    return homeAt(origin, facts)
  } catch {
    return homeAt(origin, { kind: 'unread' })
  } finally {
    clearTimeout(timer)
  }
}
