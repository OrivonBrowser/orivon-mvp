// The screenshot sheet: what to take, then where it goes. Choosing a destination closes the sheet
// and hands the choice to main, which takes the picture once the sheet is out of the way.
import { h } from '../../pages/shared/dom.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { areaAfterKey, AREAS, fullPageOffered } from './choice.js'
import type { Area } from './choice.js'
import './screenshot.css'

const LABEL: Readonly<Record<Area, string>> = { visible: 'Visible area', full: 'Full page' }
const FULL_BLOCKED = 'Close developer tools to capture the full page'

export const screenshotPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    let area: Area = 'visible'
    let fullAvailable = false
    const segments = new Map<Area, HTMLButtonElement>()
    const take = (to: 'copy' | 'save'): void => { void overlay.request({ area, to }) }

    function paint (): void {
      for (const [key, button] of segments) button.setAttribute('aria-pressed', String(key === area))
      const full = segments.get('full')
      if (full !== undefined) { full.disabled = !fullAvailable; full.title = fullAvailable ? '' : FULL_BLOCKED }
    }

    for (const key of AREAS) {
      const button = h('button', { type: 'button', onclick: () => { area = key; paint() } }, LABEL[key])
      button.dataset['area'] = key
      segments.set(key, button)
    }
    const group = h('div', { className: 'segmented', role: 'group', ariaLabel: 'What to capture' }, ...segments.values())
    group.addEventListener('keydown', (event) => {
      if (!event.key.startsWith('Arrow')) return
      event.preventDefault()
      area = areaAfterKey(area, event.key, fullAvailable)
      paint()
      segments.get(area)?.focus()
    })

    const save = h('button', { type: 'button', className: 'btn', onclick: () => { take('save') } }, 'Save…')
    const copy = h('button', { type: 'button', className: 'btn primary', onclick: () => { take('copy') } }, 'Copy')
    content.append(h('div', { className: 'shot', role: 'dialog', ariaLabel: 'Take a screenshot' },
      h('h1', { className: 'sheet-title' }, 'Take a screenshot'),
      h('div', { className: 'sheet-body' }, group),
      h('div', { className: 'btn-row' }, save, copy)))
    paint()

    return {
      shown (payload) {
        fullAvailable = fullPageOffered(payload)
        area = 'visible'
        paint()
        copy.focus()
      }
    }
  }
}
