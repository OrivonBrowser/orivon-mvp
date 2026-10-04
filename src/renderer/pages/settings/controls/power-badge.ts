// Where the computer's power comes from, as a badge beside the energy saver. It asks the page's own Battery API,
// which can be missing or refuse (a desktop, a page without the permission), and then says so instead of guessing.
import { h } from '../../shared/dom.js'

export type PowerSource = 'battery' | 'mains' | 'unknown'

/** The badge's text and tone for a source. */
export function powerBadge (source: PowerSource): { text: string, tone: 'ok' | '' } {
  if (source === 'battery') return { text: 'On battery now', tone: 'ok' }
  if (source === 'mains') return { text: 'Plugged in', tone: '' }
  return { text: 'Not detected', tone: '' }
}

interface BatteryLike { charging: boolean, addEventListener: (type: 'chargingchange', listener: () => void) => void }

export function sourceOf (battery: Pick<BatteryLike, 'charging'> | null): PowerSource {
  if (battery === null) return 'unknown'
  return battery.charging ? 'mains' : 'battery'
}

/** The one badge: a redraw of the section moves it rather than subscribing to the battery again. */
let kept: HTMLElement | undefined

/** The badge, kept current while the page is open. */
export function renderPowerBadge (): HTMLElement {
  if (kept !== undefined) return kept
  const badge = h('span', { className: 'badge', role: 'status' })
  kept = badge
  const show = (source: PowerSource): void => {
    const { text, tone } = powerBadge(source)
    badge.className = tone === '' ? 'badge' : `badge ${tone}`
    badge.textContent = text
  }
  show('unknown')
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }
  if (typeof nav.getBattery === 'function') {
    nav.getBattery().then((battery) => {
      show(sourceOf(battery))
      battery.addEventListener('chargingchange', () => { show(sourceOf(battery)) })
    }, () => { show('unknown') })
  }
  return badge
}
