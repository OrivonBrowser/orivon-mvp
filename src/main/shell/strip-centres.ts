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

/** One tab's box in the chrome page, as the page reports it: a tab hidden in a collapsed group has none. */
export interface StripBox {
  readonly hidden: boolean
  readonly left: number
  readonly width: number
}

export const STRIP_LAYOUT_SCRIPT = `(() => {
  const tabs = [...document.querySelectorAll('#tabrow .tab')]
  return {
    ids: tabs.map((tab) => tab.dataset.id),
    boxes: tabs.map((tab) => {
      if (tab.hidden) return { hidden: true, left: 0, width: 0 }
      const box = tab.getBoundingClientRect()
      return { hidden: false, left: box.left, width: box.width }
    })
  }
})()`

/** The centre of each tab. A tab hidden in a collapsed group takes no room and stands at the centre of the shown
 * tab before it (0 when none is), so a pointer past that tab's centre counts the hidden run and drops after it:
 * the place the strip's own drag gives (`placeAmongAll`), and the one the drop mark is drawn at. */
export function centresOf (boxes: readonly StripBox[]): number[] {
  let previous = 0
  return boxes.map((box) => {
    if (box.hidden) return previous
    previous = box.left + box.width / 2
    return previous
  })
}

const layouts = new WeakMap<ShellWindow, StripLayout>()
const reading = new WeakMap<ShellWindow, Promise<void>>()

/** The layout the page reported, or null when it is not one: every id a string, every box of finite numbers. */
export function parseStripBoxes (value: unknown): StripLayout | null {
  if (typeof value !== 'object' || value === null) return null
  const { ids, boxes } = value as Record<string, unknown>
  if (!Array.isArray(ids) || !Array.isArray(boxes) || ids.length !== boxes.length) return null
  const sound = boxes.every((box: unknown) => {
    if (typeof box !== 'object' || box === null) return false
    const { hidden, left, width } = box as Record<string, unknown>
    return typeof hidden === 'boolean' && typeof left === 'number' && Number.isFinite(left) && typeof width === 'number' && Number.isFinite(width)
  })
  return sound ? parseStripLayout({ ids, centres: centresOf(boxes as StripBox[]) }) : null
}

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

/** Reads the strip's layout off the window's chrome page. One read per window at a time: a call during a read
 * waits for that read. A page that is reloading or gone leaves what was known. */
export function refreshStripLayout (window: ShellWindow): Promise<void> {
  const running = reading.get(window)
  if (running !== undefined) return running
  if (window.window.isDestroyed() || window.chrome.webContents.isDestroyed()) return Promise.resolve()
  const read = (async () => {
    try {
      const layout = parseStripBoxes(await window.chrome.webContents.executeJavaScript(STRIP_LAYOUT_SCRIPT))
      if (layout !== null) layouts.set(window, layout)
    } catch {
      // The chrome page is reloading: the next read finds it.
    } finally {
      reading.delete(window)
    }
  })()
  reading.set(window, read)
  return read
}

/** Reads the layouts of `windows`, giving up after `ms` so a busy or still loading chrome page never holds back
 * what the caller does with whatever is known. */
export async function refreshStripLayouts (windows: readonly ShellWindow[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })
  try {
    await Promise.race([Promise.all(windows.map(refreshStripLayout)), late])
  } finally {
    clearTimeout(timer)
  }
}
