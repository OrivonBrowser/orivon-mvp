// The one entry every overlay loads: it finds the page registered for this
// view's overlay, mounts it, tells it about each show, reports the content
// height so main can size the view, and closes on Escape.
import { h } from '../pages/shared/dom.js'
import { createOverlay, mountPage, readyEvents, shownPayload } from './kit.js'
import { OVERLAY_PAGES } from './pages.js'

const content = document.getElementById('content')
const bridge = window.orivonOverlay

function showError (root: HTMLElement): void {
  root.replaceChildren(h('div', { className: 'overlay-error', role: 'alert' }, 'This panel could not be shown.'))
}

if (content === null) throw new Error('overlay document has no #content')
if (bridge === undefined) {
  // The preload exposes nothing at any address but the one main built.
  showError(content)
} else {
  const params = new URLSearchParams(location.search)
  const surface = params.get('surface')
  document.body.dataset['surface'] = surface === 'menu' || surface === 'page' ? surface : 'panel'
  document.body.dataset['overlay'] = bridge.name

  const overlay = createOverlay(bridge)
  const page = Object.hasOwn(OVERLAY_PAGES, bridge.name) ? OVERLAY_PAGES[bridge.name] : undefined
  const mounted = mountPage(page, content, overlay, showError)

  bridge.onEvent((message) => {
    const show = shownPayload(message, 'show')
    if (show !== null) mounted.shown(show.payload)
  })

  // #content is as tall as the page wants whatever the view's own size is, so
  // it is what to measure; #scroll is the box that scrolls when the view is shorter.
  let reported = -1
  const report = (): void => {
    const height = Math.ceil(content.getBoundingClientRect().height)
    if (height === reported) return
    reported = height
    bridge.size(height)
  }
  new ResizeObserver(report).observe(content)

  // Escape closes unless the page took it (an open select, a cleared field).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) bridge.close('escape')
  })

  void bridge.ready().then((reply) => {
    const show = shownPayload(reply, 'ready')
    if (show !== null) mounted.shown(show.payload)
    // After the show: a page that starts its state afresh on a show must not lose what arrived while it loaded.
    overlay.replay(readyEvents(reply))
  }).catch(() => {})
}
