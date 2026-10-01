// The entries other code adds to every window's view picker, and the listeners told when one is chosen. Module
// state, because an entry belongs to the process (an extension), not to a window.
import type { ShellWindow } from '../shell/window-registry.js'

/** An entry of the picker that Orivon does not draw: `id` is `ext:<extensionId>`. */
export interface PanelGuestEntry { id: string, title: string, icon?: string }

const ENTRY_ID = /^ext:[A-Za-z0-9._-]{1,64}$/
const MAX_ENTRIES = 50
const MAX_TITLE = 100
const MAX_ICON = 48_000

let entries: readonly PanelGuestEntry[] = []
const chosen = new Set<(window: ShellWindow, entryId: string) => void>()
const entryListeners = new Set<() => void>()

/** What a picker may show of one entry: a listed id, a short title, and an icon only if it is an image the page can draw. */
function vetted (entry: PanelGuestEntry): PanelGuestEntry | null {
  if (typeof entry.id !== 'string' || !ENTRY_ID.test(entry.id) || typeof entry.title !== 'string' || entry.title.trim() === '') return null
  const icon = typeof entry.icon === 'string' && entry.icon.length <= MAX_ICON && /^data:image\/(png|jpeg|gif|webp|svg\+xml);/.test(entry.icon) ? entry.icon : undefined
  return { id: entry.id, title: entry.title.slice(0, MAX_TITLE), ...(icon === undefined ? {} : { icon }) }
}

/** Replaces the entries every window's picker lists after Orivon's own views, by title. */
export function setGuestEntries (next: readonly PanelGuestEntry[]): void {
  const seen = new Set<string>()
  entries = next.flatMap((entry) => {
    const kept = vetted(entry)
    if (kept === null || seen.has(kept.id)) return []
    seen.add(kept.id)
    return [kept]
  }).sort((a, b) => a.title.localeCompare(b.title)).slice(0, MAX_ENTRIES)
  for (const listener of [...entryListeners]) listener()
}

export const guestEntries = (): readonly PanelGuestEntry[] => entries

export const isGuestEntry = (id: string): boolean => entries.some((entry) => entry.id === id)

/** Runs when a picker, `open(entryId)` or `toggle(entryId)` asks for an entry to be shown: the listener owns the view and answers with `setGuest`. */
export function onGuestChosen (listener: (window: ShellWindow, entryId: string) => void): () => void {
  chosen.add(listener)
  return () => { chosen.delete(listener) }
}

export function announceChosen (window: ShellWindow, entryId: string): void {
  for (const listener of [...chosen]) {
    try { listener(window, entryId) } catch (error) { console.error('[side-panel] a guest listener failed', error) }
  }
}

/** A host tells its page when the entries change; returns the stop. */
export function watchGuestEntries (listener: () => void): () => void {
  entryListeners.add(listener)
  return () => { entryListeners.delete(listener) }
}
