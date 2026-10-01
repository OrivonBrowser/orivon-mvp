// Chrome's write quota for chrome.bookmarks: a runaway loop in one extension cannot rewrite the person's
// tree without end. Counted per extension; reads are free. The refusal carries Chrome's own wording.
export const MAX_WRITE_OPERATIONS_PER_HOUR = 1000
export const MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE = 100

const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

export interface WriteQuota {
  /** Counts one write by `extensionId`, or throws Chrome's quota error and counts nothing. */
  readonly take: (extensionId: string) => void
  readonly forget: (extensionId: string) => void
}

export function createWriteQuota (now: () => number = Date.now): WriteQuota {
  const writes = new Map<string, number[]>()
  return {
    take: (extensionId) => {
      const at = now()
      const recent = (writes.get(extensionId) ?? []).filter((time) => at - time < HOUR_MS)
      if (recent.length >= MAX_WRITE_OPERATIONS_PER_HOUR) {
        throw new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.')
      }
      if (recent.filter((time) => at - time < MINUTE_MS).length >= MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE) {
        throw new Error('This request exceeds the MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE quota.')
      }
      recent.push(at)
      writes.set(extensionId, recent)
    },
    forget: (extensionId) => { writes.delete(extensionId) }
  }
}
