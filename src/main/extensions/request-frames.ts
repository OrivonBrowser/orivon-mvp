// What a request's frame says about it, in Chrome's terms: the frame ids and
// the initiating origin that declarativeNetRequest conditions and `chrome.
// webRequest` details both carry. A frame is read through the three fields
// Electron's `WebFrameMain` has, so this file imports nothing from `electron`.

/** The part of Electron's `WebFrameMain` read here. */
export interface FrameLike {
  readonly parent: FrameLike | null
  readonly frameTreeNodeId: number
  readonly origin: string
}

export function frameIdOf(frame: FrameLike): number {
  // Chrome numbers a page's own top frame 0; frameTreeNodeId is Electron's
  // closest stable per-frame id otherwise.
  return frame.parent === null ? 0 : frame.frameTreeNodeId
}

export function parentFrameIdOf(frame: FrameLike): number | undefined {
  return frame.parent === null ? undefined : frameIdOf(frame.parent)
}

/** `details.frame` can throw when read after the frame navigated away or
 * was destroyed (Electron's own doc on the field; `../verifier/
 * verifier-subsystem.ts` guards the same read the same way). */
export function safeFrame(details: { frame?: FrameLike | null }): FrameLike | null {
  try {
    return details.frame ?? null
  } catch {
    return null
  }
}

/** The origin of the frame that made the request -- for a subresource load,
 * `frame` already IS the requesting document. For a `main_frame`/`sub_frame`
 * navigation, `frame.origin` still reads the PREVIOUS document's origin at
 * this point (the new one has not committed): a best-effort approximation of
 * Chrome's own `initiator` for a RENDERER-initiated navigation (e.g. a link
 * click, where the previous document and the initiator are the same page),
 * but not for a BROWSER-initiated one (typed in the address bar, a bookmark,
 * forward/back), where Chrome reports no initiator at all and this still
 * reads whatever the frame's previous document happened to be -- Electron's
 * `webRequest` API exposes no field to tell the two apart. `"null"` (Chrome's
 * own serialization of an opaque origin) and `""` both mean "no usable
 * initiator" here. */
export function initiatorOf(frame: FrameLike | null): string | undefined {
  if (frame === null) {
    return undefined
  }
  try {
    const origin = frame.origin
    return origin === 'null' || origin === '' ? undefined : origin
  } catch {
    return undefined
  }
}
