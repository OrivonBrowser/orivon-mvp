// The small mark at the left of a History row. The store keeps no favicon
// today (src/main/history/history-store.ts's HistoryEntry has none), so every
// row falls back to a mark this page can draw on its own: a badge naming the
// protocol for a dweb address a hostname alone would not explain, or a
// letter coloured by the site's host otherwise. One function decides this, so
// a row's mark and its accessible label are never worked out twice.
import { h } from '../shared/dom.js'

const PROTOCOL_BADGES: Readonly<Record<string, { readonly text: string, readonly color: string }>> = {
  'ipfs:': { text: 'IPFS', color: 'ipfs' },
  'ipns:': { text: 'IPNS', color: 'ipns' }
}

const HOST_COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'pink', 'teal', 'gray'] as const

/** A short, stable colour for a host: the same address always gets the same one. */
function hostColor (host: string): string {
  let hash = 0
  for (let index = 0; index < host.length; index += 1) hash = (hash * 31 + host.charCodeAt(index)) % HOST_COLORS.length
  return HOST_COLORS[Math.abs(hash) % HOST_COLORS.length] as string
}

function hostOf (url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export function siteMark (url: string): HTMLElement {
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    protocol = ''
  }
  const badge = PROTOCOL_BADGES[protocol]
  if (badge !== undefined) return withColor(h('span', { className: 'mark site-mark protocol', textContent: badge.text, title: badge.text }), badge.color)

  const host = hostOf(url)
  if (host.endsWith('.eth')) return withColor(h('span', { className: 'mark site-mark protocol', textContent: 'ENS', title: 'A .eth name' }), 'ens')

  const letter = (host.replace(/^www\./, '')[0] ?? '?').toUpperCase()
  return withColor(h('span', { className: 'mark site-mark letter', textContent: letter }), hostColor(host))
}

function withColor (el: HTMLElement, color: string): HTMLElement {
  el.dataset['color'] = color
  return el
}
