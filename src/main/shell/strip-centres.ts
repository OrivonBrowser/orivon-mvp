// Where each tab of a window sits in its strip. Only the chrome page knows (tabs are at most 240px wide and
// packed to the left, so the strip is not spread over the window), and main needs it to tell which slot a
// tab dragged in from another window would take. Main reads it from its own chrome page, never from a
// message the page sends.
import type { ShellWindow } from './window-registry.js'

/** Centres are in the chrome page's pixels, from the left edge of the window's content area, in the order of
 * `ids` (the strip's tabs, which is the order of the tab state). */
export interface StripLayout {
  readonly ids: readonly string[]
  readonly centres: readonly number[]
}

/** A tab hidden in a collapsed group takes no room: it stands at the left edge of the next tab shown, or the
 * right edge of the last one, so the centres stay in order. */
export const STRIP_LAYOUT_SCRIPT = `(() => {
  const tabs = [...document.querySelectorAll('#tabrow .tab')]
  const centres = new Array(tabs.length)
  let edge = null
  for (let i = tabs.length - 1; i >= 0; i--) {
    if (tabs[i].hidden) { centres[i] = edge; continue }
    const box = tabs[i].getBoundingClientRect()
    centres[i] = box.left + box.width / 2
    edge = box.left
  }
  const last = tabs.filter((tab) => !tab.hidden).at(-1)
  const end = last === undefined ? 0 : last.getBoundingClientRect().right
  return { ids: tabs.map((tab) => tab.dataset.id), centres: centres.map((centre) => centre === null ? end : centre) }
})()`

const layouts = new WeakMap<ShellWindow, StripLayout>()
const reading = new WeakSet<ShellWindow>()

/** The layout, or null when `value` is not one: every id a string, every centre a finite number, as many of
 * each, none before the one ahead of it. */
export function parseStripLayout (value: unknown): StripLayout | null {
  if (typeof value !== 'object' || value === null) return null
  const { ids, centres } = value as Record<string, unknown>
  if (!Array.isArray(ids) || !Array.isArray(centres) || ids.length !== centres.length) return null
  if (!ids.every((id) => typeof id === 'string')) return null
  if (!centres.every((centre, at) => typeof centre === 'number' && Number.isFinite(centre) && (at === 0 || centre >= (centres[at - 1] as number)))) return null
  return { ids: ids as string[], centres: centres as number[] }
}

/** Remembers what the window's strip looked like. False when `value` is not a layout. */
export function rememberStripLayout (window: ShellWindow, value: unknown): boolean {
  const layout = parseStripLayout(value)
  if (layout === null) return false
  layouts.set(window, layout)
  return true
}

/** The tab centres, or null when none are known or they are of another set of tabs than the window has now
 * (a tab closed or opened since): the caller then has only the share of the window's width to go by. */
export function stripCentresFor (window: ShellWindow): readonly number[] | null {
  const layout = layouts.get(window)
  if (layout === undefined) return null
  const ids = window.tabs.getState().tabs.map((tab) => tab.id)
  return ids.length === layout.ids.length && ids.every((id, at) => id === layout.ids[at]) ? layout.centres : null
}

/** Reads the strip's layout off the window's chrome page. At most one read per window at a time; a page that
 * is reloading or gone leaves what was known. */
export async function refreshStripLayout (window: ShellWindow): Promise<void> {
  if (reading.has(window) || window.window.isDestroyed() || window.chrome.webContents.isDestroyed()) return
  reading.add(window)
  try {
    rememberStripLayout(window, await window.chrome.webContents.executeJavaScript(STRIP_LAYOUT_SCRIPT))
  } catch {
    // The chrome page is reloading: the next read finds it.
  } finally {
    reading.delete(window)
  }
}
