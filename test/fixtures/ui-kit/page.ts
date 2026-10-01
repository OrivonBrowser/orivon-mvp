// Fills the fixture's icon slots and the states markup cannot express (a
// mixed checkbox), so index.html stays a plain listing of the kit's markup.
import * as icons from '../../../src/renderer/pages/shared/icons.js'

type IconName = keyof typeof icons

/** The icons the kit adds, in the order the gallery draws them. */
export const NEW_ICONS = [
  'download', 'folder', 'folderOpen', 'file', 'star', 'chevronRight', 'chevronDown', 'close', 'check', 'plus', 'more',
  'pin', 'speaker', 'speakerOff', 'warning', 'lock', 'key', 'printer', 'externalLink', 'copy', 'pencil', 'refresh',
  'home', 'panelRight', 'puzzle', 'pause', 'play', 'eye', 'eyeOff', 'arrowUp', 'arrowDown'
] as const

function build (name: string): SVGSVGElement {
  const make = icons[`${name}Icon` as IconName] as (() => SVGSVGElement) | undefined
  if (make === undefined) throw new Error(`no icon named ${name}`)
  return make()
}

for (const slot of document.querySelectorAll<HTMLElement>('[data-icon]')) {
  const glyph = build(slot.dataset.icon ?? '')
  if (slot.className === '' && slot.tagName === 'SPAN') slot.replaceWith(glyph)
  else slot.prepend(glyph)
}

const grid = document.getElementById('icon-grid')
for (const name of NEW_ICONS) {
  const cell = document.createElement('div')
  cell.className = 'icon-cell'
  cell.dataset.iconName = name
  const label = document.createElement('span')
  label.textContent = name
  cell.append(build(name), label)
  grid?.append(cell)
}

const sizes = document.getElementById('sizes')
for (const [name, size] of [['download', 's16'], ['download', 's20'], ['download', 's24'], ['warning', 's16'], ['warning', 's20'], ['warning', 's24'], ['puzzle', 's16'], ['puzzle', 's24']] as const) {
  const glyph = build(name)
  glyph.classList.add(size)
  sizes?.append(glyph)
}

const mixed = document.getElementById('indeterminate')
if (mixed instanceof HTMLInputElement) mixed.indeterminate = true
document.documentElement.dataset.ready = 'true'
