// The one placeholder for an extension without an icon: a tile with the first letter of its name, so every
// surface (toolbar, menu, sheet, list, details, shortcuts) shows the same thing.
import { h } from './dom.js'

/** The first letter of a name, upper case, or a question mark for an empty one. */
export function initialOf (name: string): string {
  const first = Array.from(name.trim())[0]
  return first === undefined ? '?' : first.toUpperCase()
}

/** A tile; the surface's own class sets its size, radius and letter size. */
export function letterTile (name: string, className: string, tag: 'span' | 'div' = 'span'): HTMLElement {
  const tile = h(tag, { className: `${className} letter-tile`, textContent: initialOf(name) })
  tile.setAttribute('aria-hidden', 'true')
  return tile
}
