import { downloadIcon } from '../pages/shared/icons.js'
import type { ChromeContext, ChromeModule } from './context.js'
import { RING_RADIUS, buttonTitle, ringDash, ringMode } from './downloads-ring.js'

const SVG = 'http://www.w3.org/2000/svg'
const PEEK_OVERLAY = 'downloads-peek'

/** The key as the platform writes it, for the tooltip: the default binding, which Settings can change. */
const keyHint = (platform: string | undefined): string => platform === 'darwin' ? '⌘J' : 'Ctrl+J'

function ringElement (): { svg: SVGSVGElement, arc: SVGCircleElement } {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('class', 'dl-ring')
  svg.setAttribute('aria-hidden', 'true')
  const circle = (className: string): SVGCircleElement => {
    const el = document.createElementNS(SVG, 'circle')
    el.setAttribute('class', className)
    el.setAttribute('cx', '16')
    el.setAttribute('cy', '16')
    el.setAttribute('r', String(RING_RADIUS))
    svg.append(el)
    return el
  }
  circle('dl-ring-track')
  return { svg, arc: circle('dl-ring-arc') }
}

/** The downloads button: a ring that fills while files arrive, a dot that says one wants a look, and the
 * bubble on a click (the list, in the overlay `downloads`). A middle click opens the Downloads page. Main asks
 * for the peek (`{ peek: true }`) because only this side knows where the button is. */
export function createDownloadsButton (): ChromeModule {
  let button: HTMLButtonElement | undefined
  let arc: SVGCircleElement | undefined
  let peekWaiting = false

  function peek (ctx: ChromeContext): void {
    if (button === undefined) return
    // The state that shows the button may arrive just after the event that opens the peek: wait for it.
    if (button.hidden) { peekWaiting = true; return }
    peekWaiting = false
    void ctx.shell.act('overlay.toggle', { name: PEEK_OVERLAY, anchor: ctx.anchorFor(button) })
  }

  return {
    name: 'downloads-button',
    init: (ctx) => {
      const made = ctx.toolbarButton({
        id: 'downloads',
        slot: 'cluster',
        order: 10,
        label: 'Downloads',
        icon: downloadIcon,
        onClick: (el) => { void ctx.shell.act('overlay.toggle', { name: 'downloads', anchor: ctx.anchorFor(el) }) },
        presses: 'downloads'
      })
      const ring = ringElement()
      arc = ring.arc
      made.setAttribute('aria-haspopup', 'dialog')
      made.hidden = true
      made.append(ring.svg, Object.assign(document.createElement('span'), { className: 'dl-dot' }))
      // A middle press would start Chromium's autoscroll before the release that opens the page.
      made.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
      made.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return
        event.preventDefault()
        ctx.shell.openInternal('downloads')
      })
      button = made
    },
    render: (state, ctx) => {
      const { downloads } = state
      if (button === undefined || arc === undefined) return
      button.hidden = !downloads.shown
      button.dataset['ring'] = ringMode(downloads)
      button.dataset['paused'] = String(downloads.paused)
      button.dataset['attention'] = downloads.attention
      arc.style.strokeDasharray = ringDash(downloads.fraction)
      button.title = buttonTitle(downloads, keyHint(document.documentElement.dataset['platform']))
      if (peekWaiting && downloads.shown) peek(ctx)
    },
    event: (payload, ctx) => {
      if (typeof payload === 'object' && payload !== null && (payload as { peek?: unknown }).peek === true) peek(ctx)
    }
  }
}
