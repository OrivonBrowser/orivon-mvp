// The reader page: one article in a centred column, set in the person's type, size, width and colours. It
// draws what main handed over, as text, and asks main for everything else.
import { internalBridge } from '../shared/bridge.js'
import { h } from '../shared/dom.js'
import { readerIcon } from '../shared/icons.js'
import { createBar } from './bar.js'
import type { Bar } from './bar.js'
import { renderNode } from './render.js'
import { SpeechController } from './speech.js'
import type { SpeechEnv, UtteranceLike, VoiceLike } from './speech.js'
import { createSpeechBar } from './speech-bar.js'
import { ReaderState } from './state.js'
import { WIDTHS, blockNodes, metaParts, speechUnits } from './view.js'
import type { SpeechUnit } from './view.js'

/** How long a load may take before the page shows that it is working: a quick one never flashes. */
const SKELETON_DELAY_MS = 150
/** How long the system gets to announce its voices before the page says there are none. */
const VOICES_WAIT_MS = 2000

const bridge = internalBridge()
const state = new ReaderState(bridge)
const root = document.documentElement

const speechEnv: SpeechEnv = {
  synth: {
    speak: (utterance) => { window.speechSynthesis.speak(utterance as unknown as SpeechSynthesisUtterance) },
    cancel: () => { window.speechSynthesis.cancel() },
    getVoices: () => window.speechSynthesis.getVoices() as VoiceLike[]
  },
  utterance: (text) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike
}

let units: SpeechUnit[] = []
let bar: Bar
const speech = new SpeechController(speechEnv, () => { onSpeech() })
const speechBar = createSpeechBar(speech, () => { stopReading() })
const column = h('main', { className: 'column' })
column.tabIndex = -1
let body: HTMLElement | undefined
let skeletonTimer: ReturnType<typeof setTimeout> | undefined
let voicesSettled = false
let reading = false

function applyPrefs (): void {
  root.dataset['font'] = state.prefs.font
  root.dataset['theme'] = state.prefs.theme
  root.style.setProperty('--reader-size', `${state.prefs.size}px`)
  root.style.setProperty('--reader-width', `${String(WIDTHS[state.prefs.width as keyof typeof WIDTHS] ?? WIDTHS.medium)}em`)
  bar.refresh()
}

function message (text: string, withBack: boolean): HTMLElement {
  return h('div', { className: 'empty-state' }, readerIcon(), h('p', { textContent: text }),
    withBack ? h('button', { className: 'link-btn', type: 'button', textContent: 'Back to page', onclick: () => { state.back() } }) : null)
}

function skeleton (): HTMLElement {
  const lines = [60, 100, 92, 100, 84, 100, 96, 70].map((width) => {
    const line = h('span', { className: 'skeleton' })
    line.style.width = `${String(width)}%`
    return line
  })
  const wrap = h('div', { className: 'loading' }, h('span', { className: 'skeleton title-line' }), ...lines)
  wrap.setAttribute('aria-hidden', 'true')
  return wrap
}

function drawBody (): void {
  const article = state.article
  if (article === null || body === undefined) return
  body.replaceChildren(...blockNodes(article.blocks, state.images).map((node) => renderNode(node, (index) => { state.openLink(index) })))
  markReading()
}

function drawArticle (): void {
  const article = state.article
  if (article === null) return
  document.title = article.title === '' ? 'Reader view' : article.title
  root.lang = article.lang === '' ? 'en' : article.lang
  const meta = h('p', { className: 'meta' }, ...metaParts(article).map((part) => h('span', { textContent: part })))
  body = h('div', { className: 'body' })
  column.replaceChildren(h('h1', { textContent: article.title === '' ? 'Untitled' : article.title }), meta, body)
  drawBody()
  window.scrollTo(0, 0)
  units = speechUnits(article.blocks)
  speech.setUnits(units.map((unit) => unit.text), article.lang)
  stopReading()
}

function drawStatus (): void {
  if (skeletonTimer !== undefined) clearTimeout(skeletonTimer)
  skeletonTimer = undefined
  body = undefined
  if (state.status === 'ready') {
    drawArticle()
  } else if (state.status === 'empty') {
    document.title = 'Reader view'
    column.replaceChildren(message('Nothing to read here yet. Open an article and press F9, or choose Reader view from the menu, to read it without the clutter around it.', false))
  } else if (state.status === 'error') {
    document.title = 'Reader view'
    column.replaceChildren(message('This page could not be shown in reader view.', true))
  } else {
    column.replaceChildren()
    skeletonTimer = setTimeout(() => { if (state.status === 'loading') column.replaceChildren(skeleton()) }, SKELETON_DELAY_MS)
  }
  syncReadAloud()
}

function markReading (): void {
  for (const element of document.querySelectorAll('.reading')) element.classList.remove('reading')
  if (!reading || speech.state === 'idle') return
  const unit = units[speech.index]
  if (unit === undefined) return
  const element = column.querySelector(`[data-block="${String(unit.at)}"]`)
  if (element === null) return
  element.classList.add('reading')
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' })
}

function syncReadAloud (): void {
  const hasVoices = speech.available
  const mode = reading ? 'on' : hasVoices ? 'ready' : voicesSettled ? 'none' : 'unknown'
  bar.setReadAloud(state.status === 'ready' || mode === 'none' ? mode : 'unknown', toggleReading)
}

function onSpeech (): void {
  speechBar.render()
  markReading()
}

function toggleReading (): void {
  if (reading) {
    stopReading()
    return
  }
  if (!speech.available || state.status !== 'ready') return
  reading = true
  speechBar.show(true)
  speech.play(0)
  syncReadAloud()
}

function stopReading (): void {
  const wasReading = reading
  reading = false
  speech.stop()
  speechBar.show(false)
  markReading()
  if (wasReading) syncReadAloud()
}

bar = createBar(state)
document.getElementById('app')?.append(h('div', { className: 'reader' }, bar.element, speechBar.element, column))
speechBar.render()

state.onChange((what) => {
  applyPrefs()
  if (what === 'all') drawStatus()
  else if (what === 'image') drawBody()
})
bridge.onEvent((topic, payload) => { state.handle(topic, payload) })

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  event.preventDefault()
  if (!bar.closeBubble()) state.back()
})

let lastY = 0
window.addEventListener('scroll', () => {
  const y = window.scrollY
  if (Math.abs(y - lastY) < 6) return
  root.dataset['bar'] = y > 64 && y > lastY ? 'hidden' : 'shown'
  lastY = y
}, { passive: true })

window.addEventListener('pagehide', () => { speech.stop() })
window.speechSynthesis.addEventListener('voiceschanged', () => { syncReadAloud(); speechBar.render() })
setTimeout(() => { voicesSettled = true; syncReadAloud() }, VOICES_WAIT_MS)

applyPrefs()
drawStatus()
void state.load()
