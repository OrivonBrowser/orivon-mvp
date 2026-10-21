import { path, svg } from '../icons.js'
import type { ChromeModule } from './context.js'
import { must } from './context.js'

/** Drawn one unit to a pixel, so the marks stay sharp on a screen that does not scale. */
function glyph (filled: boolean, ...paths: string[]): SVGSVGElement {
  const el = svg('0 0 14 14')
  el.append(...paths.map((d) => {
    const mark = path(d, filled ? '0' : '1.3')
    if (filled) mark.setAttribute('fill', 'currentColor')
    return mark
  }))
  return el
}

function windowButton (kind: string, label: string, icon: SVGSVGElement | null, onClick?: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `mac-window-button ${kind}`
  button.title = label
  button.setAttribute('aria-label', label)
  if (icon !== null) button.append(icon)
  if (onClick === undefined) button.disabled = true
  else button.addEventListener('click', onClick)
  return button
}

/** macOS hides a window's close, minimise and full-screen buttons in full screen and shows them only in a bar that
 * slides over the tabs when the pointer reaches the top of the screen. The chrome draws the same three where they sit
 * outside full screen, so they stay in reach: close closes the window, the green one leaves full screen, and minimise
 * is greyed, as macOS has it in full screen. Nothing is drawn on another system. */
export function createMacWindowButtons (): ChromeModule {
  let group: HTMLDivElement | undefined
  return {
    name: 'mac-window-buttons',
    init: (ctx) => {
      if (ctx.shell.platform !== 'darwin') return
      const row = must(document.getElementById('tabrow'), '#tabrow missing')
      group = document.createElement('div')
      group.id = 'mac-window-buttons'
      group.className = 'mac-window-buttons no-drag'
      group.hidden = true
      group.append(
        windowButton('close', 'Close window', glyph(false, 'M4.5 4.5l5 5', 'M9.5 4.5l-5 5'), () => { ctx.shell.runCommand('window.close') }),
        windowButton('minimize', 'Minimise is not available in full screen', null),
        windowButton('zoom', 'Exit full screen', glyph(true, 'M6.5 6.5V3L3 6.5z', 'M7.5 7.5V11L11 7.5z'), () => { ctx.shell.runCommand('window.fullscreen') }))
      row.prepend(group)
    },
    render: (state) => {
      if (group !== undefined) group.hidden = state.fullScreen !== true
    }
  }
}
