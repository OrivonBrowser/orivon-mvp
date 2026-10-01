// The reader's header: back to the page, read aloud, the Text and layout bubble and print. The bubble is a
// small non-modal dialog under its button: Escape closes it and puts the focus back, and so does a click
// or a Tab away from it.
import { h } from '../shared/dom.js'
import { arrowLeftIcon, printerIcon, speakerIcon, typeIcon } from '../shared/icons.js'
import type { PrefName, ReaderState } from './state.js'
import { SIZES, stepSize } from './view.js'

export const NO_VOICE_TITLE = 'Read aloud needs a system voice. None is installed.'

interface Choice { readonly value: string, readonly label: string }

const FONTS: readonly Choice[] = [{ value: 'sans', label: 'Sans' }, { value: 'serif', label: 'Serif' }]
const WIDTH_CHOICES: readonly Choice[] = [{ value: 'narrow', label: 'Narrow' }, { value: 'medium', label: 'Medium' }, { value: 'wide', label: 'Wide' }]
const THEMES: readonly Choice[] = [{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'sepia', label: 'Sepia' }, { value: 'dark', label: 'Dark' }]

export interface Bar {
  readonly element: HTMLElement
  /** Redraws what depends on the preferences. */
  refresh: () => void
  /** Whether the bubble is open, so Escape can close it before it leaves the page. */
  closeBubble: () => boolean
  setReadAloud: (state: 'unknown' | 'none' | 'ready' | 'on', onClick: () => void) => void
}

export function createBar (state: ReaderState): Bar {
  const back = h('button', { className: 'link-btn back', type: 'button', onclick: () => { state.back() } }, arrowLeftIcon(), 'Back to page')
  const aloud = h('button', { className: 'btn icon', type: 'button', title: 'Read aloud', disabled: true }, speakerIcon())
  aloud.setAttribute('aria-label', 'Read aloud')
  const layout = h('button', { className: 'btn icon', type: 'button', title: 'Text and layout' }, typeIcon())
  layout.setAttribute('aria-label', 'Text and layout')
  layout.setAttribute('aria-haspopup', 'dialog')
  layout.setAttribute('aria-expanded', 'false')
  const print = h('button', { className: 'btn icon', type: 'button', title: 'Print', onclick: () => { state.print() } }, printerIcon())
  print.setAttribute('aria-label', 'Print')

  const sizeValue = h('span', { className: 'size-value' })
  sizeValue.setAttribute('aria-live', 'polite')
  const smaller = h('button', { className: 'btn small', type: 'button', textContent: '−', onclick: () => { void state.setPref('size', String(stepSize(Number(state.prefs.size), -1))) } })
  smaller.setAttribute('aria-label', 'Smaller text')
  const larger = h('button', { className: 'btn small', type: 'button', textContent: '+', onclick: () => { void state.setPref('size', String(stepSize(Number(state.prefs.size), 1))) } })
  larger.setAttribute('aria-label', 'Larger text')

  const groups = new Map<PrefName, HTMLButtonElement[]>()
  function segmented (name: PrefName, label: string, choices: readonly Choice[]): HTMLElement {
    const buttons = choices.map((choice) => h('button', { type: 'button', textContent: choice.label, onclick: () => { void state.setPref(name, choice.value) } }))
    buttons.forEach((button, index) => { button.dataset['value'] = (choices[index] as Choice).value })
    groups.set(name, buttons)
    const group = h('div', { className: 'segmented' }, ...buttons)
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', label)
    return group
  }
  const row = (label: string, control: HTMLElement): HTMLElement => h('div', { className: 'bubble-row' }, h('span', { className: 'bubble-label', textContent: label }), control)

  const bubble = h('div', { className: 'bubble', hidden: true },
    row('Font', segmented('font', 'Font', FONTS)),
    row('Size', h('div', { className: 'size-stepper' }, smaller, sizeValue, larger)),
    row('Width', segmented('width', 'Width', WIDTH_CHOICES)),
    row('Colours', segmented('theme', 'Colours', THEMES)))
  bubble.setAttribute('role', 'dialog')
  bubble.setAttribute('aria-label', 'Text and layout')
  const anchor = h('div', { className: 'bubble-anchor' }, layout, bubble)

  function close (restoreFocus: boolean): boolean {
    if (bubble.hidden) return false
    bubble.hidden = true
    layout.setAttribute('aria-expanded', 'false')
    if (restoreFocus) layout.focus()
    return true
  }
  function open (): void {
    bubble.hidden = false
    layout.setAttribute('aria-expanded', 'true')
    const first = groups.get('font')?.find((button) => button.getAttribute('aria-pressed') === 'true') ?? groups.get('font')?.[0]
    first?.focus()
  }
  layout.addEventListener('click', () => { if (bubble.hidden) open(); else close(true) })
  document.addEventListener('pointerdown', (event) => {
    if (!bubble.hidden && !anchor.contains(event.target as Node)) close(false)
  })
  anchor.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null
    if (!bubble.hidden && next !== null && !anchor.contains(next)) close(false)
  })

  const element = h('header', { className: 'bar' }, back, h('span', { className: 'spacer' }), aloud, anchor, print)

  function refresh (): void {
    for (const [name, buttons] of groups) {
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset['value'] === state.prefs[name]))
    }
    const size = Number(state.prefs.size)
    sizeValue.textContent = String(size)
    smaller.disabled = size <= (SIZES[0])
    larger.disabled = size >= (SIZES[SIZES.length - 1] as number)
  }

  let aloudClick: () => void = () => {}
  aloud.addEventListener('click', () => { aloudClick() })

  return {
    element,
    refresh,
    closeBubble: () => close(true),
    setReadAloud: (mode, onClick) => {
      aloudClick = onClick
      aloud.disabled = mode === 'unknown' || mode === 'none'
      aloud.title = mode === 'none' ? NO_VOICE_TITLE : 'Read aloud'
      aloud.setAttribute('aria-pressed', String(mode === 'on'))
      aloud.classList.toggle('on', mode === 'on')
    }
  }
}
