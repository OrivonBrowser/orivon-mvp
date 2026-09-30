import type { DnrRequest } from './types.js'

/** One frame's own document, as last observed by `record()`. */
interface FrameRecord {
  url: string
  method: string
  /** `undefined` for a top (main_frame) document. */
  parentFrameId: number | undefined
}

export interface AncestorFrame {
  url: string
  initiator: string | null
  type: 'main_frame' | 'sub_frame'
  method: string
}

/**
 * Best-effort replacement for the live frame tree (`nsIBrowsingContext`)
 * `RequestDetails#ancestorRequestDetails` walks in upstream Firefox --
 * `vendor/firefox-dnr/src/extension-dnr.mjs`'s top comment and this
 * directory's README §Design notes have the full rationale. `dnr-engine.ts`
 * feeds every main_frame/sub_frame request through `record()` before
 * evaluating it, so that a later subresource or child frame in the same tab
 * can look its ancestry up.
 */
export class FrameAncestryTracker {
  // Bounds memory for a long session without a tab-close hook in this
  // package's API: once full, the oldest-inserted frame is evicted, same
  // tradeoff a fixed-size cache always makes.
  static #MAX_TRACKED_FRAMES = 2000

  #frames = new Map<string, FrameRecord>()

  #key(tabId: number, frameId: number): string {
    return `${tabId}:${frameId}`
  }

  record(request: DnrRequest): void {
    if (request.resourceType !== 'main_frame' && request.resourceType !== 'sub_frame') {
      return
    }
    const key = this.#key(request.tabId, request.frameId)
    if (this.#frames.size >= FrameAncestryTracker.#MAX_TRACKED_FRAMES && !this.#frames.has(key)) {
      const oldestKey = this.#frames.keys().next().value
      if (oldestKey !== undefined) {
        this.#frames.delete(oldestKey)
      }
    }
    this.#frames.set(key, {
      url: request.url,
      method: request.method.toLowerCase(),
      parentFrameId: request.resourceType === 'sub_frame' ? request.parentFrameId : undefined,
    })
  }

  /**
   * @param tabId
   * @param startFrameId - The frame that made the request: its own
   *   `frameId` for a subresource, or `parentFrameId` for a sub_frame
   *   document request. `undefined` for a main_frame request (no ancestors).
   * @returns The chain root-first, or `[]` if `startFrameId` (or any
   *   ancestor above it) was never recorded -- the same empty result
   *   Firefox falls back to when its frame tree is not "current".
   */
  buildAncestorChain(tabId: number, startFrameId: number | undefined): AncestorFrame[] {
    const chain: AncestorFrame[] = []
    let frameId = startFrameId
    while (frameId !== undefined) {
      const record = this.#frames.get(this.#key(tabId, frameId))
      if (!record) {
        return []
      }
      const parentUrl =
        record.parentFrameId !== undefined
          ? this.#frames.get(this.#key(tabId, record.parentFrameId))?.url
          : undefined
      chain.unshift({
        url: record.url,
        initiator: parentUrl ?? null,
        type: record.parentFrameId === undefined ? 'main_frame' : 'sub_frame',
        method: record.method,
      })
      frameId = record.parentFrameId
    }
    return chain
  }
}
