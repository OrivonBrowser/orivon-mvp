// Chromium decides, before the browser hears of a page's `alert`, `confirm` or
// `prompt`, whether the call may show anything: a document sandboxed without
// `allow-modals` is ignored, and so is a call made while the page is being left
// (its beforeunload, pagehide or unload handler), so that a page cannot put its
// own words in front of someone who is leaving. The page-dialog wrapper
// (./page-dialogs.ts) takes the call before that decision is made, so it asks
// the same two questions itself and answers a dismissed dialog when either says no.
//
// The second question is answered where the call is made (`window.event`, in
// the wrapper): a preload that listened for `beforeunload` itself would make
// every page one that has such a handler, and every navigation of it wait for
// its renderer. A page can hide the event by dispatching one of its own around
// the call.
//
// A frame's sandbox flags are not readable from a preload. What is readable is
// the opaque origin that a sandbox without `allow-same-origin` gives (a
// sandboxed frame with `allow-modals` loses its dialog too: the cautious side),
// and the `sandbox` attribute of the frame's element for every ancestor that is
// same-origin. A sandbox that keeps `allow-same-origin`, drops `allow-modals`
// and sits under a cross-origin parent is not seen.

/** The element a frame sits in lets its document show dialogs: it has no `sandbox` attribute, or the attribute grants `allow-modals`. */
function elementAllowsModals (element: Element): boolean {
  const { sandbox } = element as Element & { sandbox?: DOMTokenList }
  return sandbox === undefined || !element.hasAttribute('sandbox') || sandbox.contains('allow-modals')
}

/** True for a document whose own sandbox, or an ancestor's that this frame can read, forbids dialogs. */
export function sandboxedWithoutModals (): boolean {
  if (window.origin === 'null' && (process.isMainFrame !== true || /^https?:$/.test(location.protocol))) return true
  let frame: Window = window
  for (let depth = 0; depth < 32 && frame !== frame.top; depth += 1) {
    try {
      const { frameElement } = frame
      if (frameElement !== null && !elementAllowsModals(frameElement)) return true
      frame = frame.parent
    } catch {
      return false
    }
  }
  return false
}
