// The windows and screens the picker lists, kept current while it is open: one `getSources` in flight at a time,
// asked again every few seconds for the segment in view only. Pure over an injected `getSources`.
import type { PickerCard } from './picker-model.js'
import { cardText } from './picker-model.js'

/** What `desktopCapturer.getSources` returns for one source, as far as the picker reads it. */
export interface RawSource {
  readonly id: string
  readonly name: string
  readonly thumbnail: { isEmpty: () => boolean, toJPEG: (quality: number) => Buffer }
  readonly appIcon: { isEmpty: () => boolean, toDataURL: () => string } | null
}

export type GetSources = (type: 'window' | 'screen') => Promise<readonly RawSource[]>

export const SOURCE_REFRESH_MS = 2000
export const THUMB_QUALITY = 60

export interface SourceFeed {
  /** Lists `type` now and again every `SOURCE_REFRESH_MS`; asking for another type drops the first. */
  watch: (type: 'window' | 'screen') => void
  stop: () => void
}

export interface FeedTimers {
  readonly after: (run: () => void, ms: number) => () => void
}

const realTimers: FeedTimers = {
  after: (run, ms) => {
    const timer = setTimeout(run, ms)
    return () => { clearTimeout(timer) }
  }
}

/** `deliver` gets each answer for the type being watched; a failed listing delivers an empty list. */
export function createSourceFeed (getSources: GetSources, deliver: (type: 'window' | 'screen', sources: readonly RawSource[]) => void, timers: FeedTimers = realTimers): SourceFeed {
  let watching: 'window' | 'screen' | null = null
  let generation = 0
  let inFlight = false
  let cancelNext: (() => void) | null = null

  function tick (): void {
    cancelNext = null
    const type = watching
    if (type === null || inFlight) return
    inFlight = true
    const mine = generation
    getSources(type).catch((): readonly RawSource[] => []).then((sources) => {
      inFlight = false
      if (watching === null) return
      if (mine !== generation) { tick(); return }
      try { deliver(type, sources) } catch (error) { console.error('[screen-share] the picker could not use its sources:', error) }
      cancelNext?.()
      cancelNext = timers.after(tick, SOURCE_REFRESH_MS)
    })
  }

  return {
    watch (type) {
      if (watching === type) return
      watching = type
      generation++
      cancelNext?.()
      cancelNext = null
      // A listing still in flight for the other type is dropped when it ends, and this type is listed then.
      tick()
    },
    stop () {
      watching = null
      generation++
      cancelNext?.()
      cancelNext = null
    }
  }
}

/** A source as a card: a JPEG thumbnail, and a window's own icon. */
export function sourceCard (source: RawSource, id: string): PickerCard {
  let thumb: string | null = null
  if (!source.thumbnail.isEmpty()) {
    try { thumb = `data:image/jpeg;base64,${source.thumbnail.toJPEG(THUMB_QUALITY).toString('base64')}` } catch { thumb = null }
  }
  let icon: string | null = null
  if (source.appIcon !== null && !source.appIcon.isEmpty()) {
    try { icon = source.appIcon.toDataURL() } catch { icon = null }
  }
  return { id, label: cardText(source.name) || 'Untitled', sub: null, thumb, icon, self: false }
}
