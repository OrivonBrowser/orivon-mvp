// What the downloads bubble shows and what it may ask. Pure: the overlay handler applies the request.
import { isActive } from './download-model.js'
import type { DownloadEntry } from './download-types.js'

/** The bubble lists this many downloads; the rest are on the page. */
export const BUBBLE_ROWS = 6
const MAX_ID_LENGTH = 64

/** Held files first (they wait for an answer), then what is running, then the newest. The list arrives newest first and the order is kept within each group. */
export function bubbleRows (list: readonly DownloadEntry[], limit = BUBBLE_ROWS): DownloadEntry[] {
  const rank = (entry: DownloadEntry): number => entry.state === 'held' ? 0 : isActive(entry) ? 1 : 2
  return list
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .slice(0, limit)
    // The page never needs a path, and the address a download was asked from is shown only as its host.
    .map(({ entry }) => ({ ...entry, savePath: '', referrer: '' }))
}

const BY_ID = ['pause', 'resume', 'cancel', 'retry', 'remove', 'open', 'showInFolder', 'keep', 'discard'] as const
export type BubbleById = typeof BY_ID[number]

export type BubbleRequest =
  | { readonly type: BubbleById, readonly id: string }
  | { readonly type: 'openPage' | 'hold' | 'release' }

/** A request from the bubble's page, or undefined when it is not one of these. A download is named by its id, never by a path. */
export function asBubbleRequest (command: unknown): BubbleRequest | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, id, ...rest } = command as Record<string, unknown>
  if (Object.keys(rest).length > 0) return undefined
  if (type === 'openPage' || type === 'hold' || type === 'release') return id === undefined ? { type } : undefined
  if (typeof type !== 'string' || !(BY_ID as readonly string[]).includes(type)) return undefined
  return typeof id === 'string' && id !== '' && id.length <= MAX_ID_LENGTH ? { type: type as BubbleById, id } : undefined
}
