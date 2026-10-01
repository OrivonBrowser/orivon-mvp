// Whether a page holds something the person typed that sleeping would lose. Read in an isolated world, so the page
// can neither see the question nor shape the answer beyond keeping itself awake.
import type { WebContents } from 'electron'

/** The isolated world the check runs in: its own, so nothing else's variables are in reach. */
export const UNSAVED_WORLD_ID = 1070

/** How long the page has to answer. A page that does not answer in time is treated as holding input. */
export const UNSAVED_TIMEOUT_MS = 1000

/** One boolean: a text field, text area or editable region holds a value other than its default, or the person is in
 * one. Fields inside frames or shadow trees are not looked into, so a page keeping its input there is not seen. */
export const UNSAVED_SCRIPT = `(() => {
  const NOT_TEXT = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'hidden', 'image', 'range', 'color'])
  const isText = (el) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type))
  const active = document.activeElement
  if (active instanceof HTMLElement && (isText(active) || active.isContentEditable)) return true
  for (const el of document.querySelectorAll('input, textarea')) {
    if (!isText(el)) continue
    if (el.value !== el.defaultValue) return true
  }
  for (const el of document.querySelectorAll('[contenteditable]')) {
    if (el instanceof HTMLElement && el.isContentEditable && (el.textContent || '').trim() !== '') return true
  }
  return false
})()`

/** True unless the page answered, in time, that it holds nothing. A throw, a timeout and any other answer count as input. */
export async function holdsUnsavedInput (wc: WebContents, timeoutMs = UNSAVED_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    const answer: unknown = await Promise.race([
      wc.executeJavaScriptInIsolatedWorld(UNSAVED_WORLD_ID, [{ code: UNSAVED_SCRIPT }]),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { resolve('timeout') }, timeoutMs) })
    ])
    return answer !== false
  } catch {
    return true
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
