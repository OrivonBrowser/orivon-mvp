// The small mark at the left of a row: the site's own icon when one is kept, else
// one this page draws on its own: a badge naming the protocol for a dweb address a
// hostname alone would not explain, or a letter coloured by the site's host. One
// function decides this, so a row's mark and its accessible label are never worked
// out twice.
import { h } from '../shared/dom.js'

const PROTOCOL_BADGES: Readonly<Record<string, { readonly text: string, readonly color: string }>> = {
  'ipfs:': { text: 'IPFS', color: 'ipfs' },
  'ipns:': { text: 'IPNS', color: 'ipns' }
}

/** The mark of a name under a top-level domain a built-in protocol resolves, by the domain: the same address shows the same mark whichever network its content is on. */
const NAME_BADGES: ReadonlyMap<string, { readonly text: string, readonly color: string, readonly title: string }> = new Map([
  ['eth', { text: 'ENS', color: 'ens', title: 'A .eth name' }],
  ['og', { text: 'OG', color: 'og', title: 'A .og name' }]
])

/** The mark for a name under a built-in resolver's top-level domain, or undefined for any other host. */
export function nameBadgeOf (host: string): { readonly text: string, readonly color: string, readonly title: string } | undefined {
  const dot = host.lastIndexOf('.')
  return dot === -1 ? undefined : NAME_BADGES.get(host.slice(dot + 1))
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

/** `icon` is a data URL the store vouched for; anything else draws the fallback. It is only ever an `<img>`'s source. */
export function siteMark (url: string, icon?: string | null): HTMLElement {
  if (typeof icon === 'string' && icon.startsWith('data:image/')) {
    const image = h('img', { src: icon, alt: '', draggable: false })
    image.setAttribute('aria-hidden', 'true')
    return h('span', { className: 'mark site-mark icon' }, image)
  }
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    protocol = ''
  }
  const badge = PROTOCOL_BADGES[protocol]
  if (badge !== undefined) return withColor(h('span', { className: 'mark site-mark protocol', textContent: badge.text, title: badge.text }), badge.color)

  const host = hostOf(url)
  const name = nameBadgeOf(host)
  if (name !== undefined) return withColor(h('span', { className: 'mark site-mark protocol', textContent: name.text, title: name.title }), name.color)

  const letter = (host.replace(/^www\./, '')[0] ?? '?').toUpperCase()
  return withColor(h('span', { className: 'mark site-mark letter', textContent: letter }), hostColor(host))
}

function withColor (el: HTMLElement, color: string): HTMLElement {
  el.dataset['color'] = color
  return el
}
