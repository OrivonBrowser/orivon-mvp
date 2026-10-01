// What the downloads button shows for a state: the ring's dash, whether it fills or turns, and the tooltip.
// Pure, so every state is tested without a document.
import type { DownloadsButtonState } from '../../main/shell/tab-types.js'

/** The ring is a circle in a 32 by 32 box, so its length is what a dash is measured against. */
export const RING_RADIUS = 14
export const RING_LENGTH = 2 * Math.PI * RING_RADIUS
/** A download that has begun shows this much of the ring, so the ring is never invisible. */
const MIN_SHARE = 0.03
/** The arc that turns when the size is unknown. */
const UNKNOWN_SHARE = 0.25

export type RingMode = 'none' | 'fill' | 'turn'

export function ringMode (state: DownloadsButtonState): RingMode {
  if (state.active === 0) return 'none'
  return state.fraction === null ? 'turn' : 'fill'
}

/** `stroke-dasharray` for the ring's arc: the filled length, then the rest. */
export function ringDash (fraction: number | null): string {
  const share = fraction === null ? UNKNOWN_SHARE : Math.min(1, Math.max(MIN_SHARE, fraction))
  const filled = RING_LENGTH * share
  return `${filled.toFixed(2)} ${(RING_LENGTH - filled + 1).toFixed(2)}`
}

const TOOLTIP_ATTENTION: Readonly<Record<DownloadsButtonState['attention'], string>> = {
  none: '',
  done: 'Download finished',
  warn: 'A file is waiting for your answer',
  failed: 'A download failed'
}

/** The tooltip: what is running when something is, else what needs a look, else the button's name and key. */
export function buttonTitle (state: DownloadsButtonState, key: string): string {
  if (state.active > 0) {
    const count = `${String(state.active)} download${state.active === 1 ? '' : 's'}${state.paused ? ' paused' : ''}`
    return state.fraction === null ? count : `${count}, ${String(Math.round(state.fraction * 100))}%`
  }
  const attention = TOOLTIP_ATTENTION[state.attention]
  return attention === '' ? `Downloads (${key})` : `${attention} (${key})`
}
