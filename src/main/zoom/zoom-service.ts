// What zoom a page has right now: the level chosen for its site, else the
// default. Every zoom command and gesture goes through here, so a page's level
// is decided in one place and the views only carry it out.
import type { SettingsStore } from '../settings/settings-store.js'
import { stepPercent } from './zoom-steps.js'
import type { ZoomListener, ZoomStore } from './zoom-store.js'

/** The whole-page level, when a site has none of its own. */
export const NORMAL_PERCENT = 100

export class ZoomService {
  private readonly listeners = new Set<ZoomListener>()

  constructor (private readonly store: ZoomStore, private readonly settings: SettingsStore) {
    store.onChange((origin) => { this.notify(origin) })
    settings.onChange(({ key }) => { if (key === 'appearance.defaultZoom') this.notify(null) })
  }

  /** What a site with no choice of its own gets. */
  defaultPercent (): number {
    return Number(this.settings.get('appearance.defaultZoom'))
  }

  /** The level for a page at `origin`. A page with no origin (the new tab page, a shell page) is never zoomed. */
  percentFor (origin: string | null): number {
    if (origin === null) return NORMAL_PERCENT
    return this.store.get(origin) ?? this.defaultPercent()
  }

  /** One step in or out from the current level. Returning to the default forgets the choice, so the site follows the default again. */
  step (origin: string, direction: 'in' | 'out'): void {
    this.choose(origin, stepPercent(this.percentFor(origin), direction))
  }

  reset (origin: string): void {
    this.store.remove(origin)
  }

  /** Sets `percent` for a site; the default itself is stored as no choice. */
  choose (origin: string, percent: number): void {
    if (percent === this.defaultPercent()) this.store.remove(origin)
    else this.store.set(origin, percent)
  }

  /** `origin` is the site that changed, or null when it may be any. Returns the removal. */
  onChange (listener: ZoomListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify (origin: string | null): void {
    for (const listener of [...this.listeners]) listener(origin)
  }
}
