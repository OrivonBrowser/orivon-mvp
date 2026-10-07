// The welcome screen's whole behaviour, and the telemetry popup "Enter Orivon"
// opens. No preload and no bridge: the shell watches this page's URL hash
// (src/main/shell/intro-view.ts), so the page needs no capability beyond its own
// document. The one thing main sends back is the picture of the browser under
// the popup, as a 'browser-behind' event.

// The fade-outs' lengths in style.css (.overlay, .overlay.asked).
const FADE_MS = 400
const POPUP_FADE_MS = 600

const overlay = document.getElementById('overlay')
const welcome = document.getElementById('welcome')
const enter = document.getElementById('enter')
const behind = document.getElementById('behind')
const consent = document.getElementById('consent')
const accept = document.getElementById('telemetry-accept')
const deny = document.getElementById('telemetry-deny')
const hint = document.getElementById('telemetry-hint')
const query = new URLSearchParams(location.search)
const asksTelemetry = query.get('telemetry') === '1'
// Off only when the telemetry question is due again on a screen already seen: the popup shows alone.
const welcomeFirst = query.get('welcome') !== '0'

// The lines arrive in the URL, so they are only ever set as text.
function showChanges (lines: readonly string[]): void {
  const box = document.getElementById('consent-changed')
  if (box === null || lines.length === 0) return
  const lead = document.createElement('p')
  lead.textContent = 'What changed since you agreed:'
  const list = document.createElement('ul')
  for (const line of lines) {
    const item = document.createElement('li')
    item.textContent = line
    list.append(item)
  }
  box.append(lead, list)
  box.removeAttribute('hidden')
}

function leave (report: string, fadeMs: number): void {
  // "leaving" first, so the shell makes its view transparent before the fade
  // shows what is under it.
  location.hash = report
  overlay?.classList.add('leaving')
  setTimeout(() => { location.hash = 'entered' }, fadeMs)
}

interface Layer { left: number, top: number, width: number, height: number, url: string }

const isLayer = (value: unknown): value is Layer => {
  if (typeof value !== 'object' || value === null) return false
  const { left, top, width, height, url } = value as Record<string, unknown>
  return [left, top, width, height].every((n) => typeof n === 'number' && Number.isFinite(n)) && typeof url === 'string' && url.startsWith('data:image/')
}

// Each view of the browser at its place in the window; the blur is style.css's.
document.addEventListener('browser-behind', (event) => {
  const layers: unknown = (event as CustomEvent<unknown>).detail
  if (behind === null || !Array.isArray(layers) || behind.childElementCount > 0) return
  const images = layers.filter(isLayer).map((layer) => {
    const image = document.createElement('img')
    image.alt = ''
    image.src = layer.url
    Object.assign(image.style, { left: `${layer.left}%`, top: `${layer.top}%`, width: `${layer.width}%`, height: `${layer.height}%` })
    return image
  })
  behind.append(...images)
  // Shown once drawn, so it fades in whole rather than one view at a time.
  void Promise.allSettled(images.map(async (image) => { await image.decode() })).then(() => { behind.classList.add('shown') })
})

function askTelemetry (): void {
  overlay?.classList.add('asked')
  welcome?.setAttribute('inert', '')
  consent?.removeAttribute('hidden')
  showChanges(query.getAll('changed'))
  location.hash = 'asking'
  // The person has not chosen, so no button has the focus and none is the way in: Enter does nothing until one is pressed.
  let left = false
  const choose = (on: boolean): void => {
    if (left) return
    left = true
    leave(`leaving?telemetry=${on ? '1' : '0'}`, POPUP_FADE_MS)
  }
  accept?.addEventListener('click', () => { choose(true) })
  deny?.addEventListener('click', () => { choose(false) })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    const onButton = event.target instanceof HTMLButtonElement
    if (!onButton && hint !== null) hint.textContent = 'Choose Accept or Deny to continue.'
  })
}

if (!welcomeFirst && asksTelemetry) {
  welcome?.setAttribute('hidden', '')
  askTelemetry()
} else {
  // Enter has the focus, so Enter acts at once.
  enter?.focus()
  enter?.addEventListener('click', () => {
    if (asksTelemetry) askTelemetry()
    else leave('leaving', FADE_MS)
  }, { once: true })
}
