// The strip under the header while the article is read aloud: play or pause, the paragraph before and after,
// the speed, the voice, and a way to stop. It shows what the controller holds and tells it what was pressed.
import { h } from '../shared/dom.js'
import { arrowDownIcon, arrowUpIcon, closeIcon, pauseIcon, playIcon } from '../shared/icons.js'
import { RATES } from './speech.js'
import type { SpeechController } from './speech.js'

export interface SpeechBar {
  readonly element: HTMLElement
  render: () => void
  show: (visible: boolean) => void
}

function iconButton (label: string, icon: SVGSVGElement, onClick: () => void): HTMLButtonElement {
  const button = h('button', { className: 'btn icon', type: 'button', title: label, onclick: onClick }, icon)
  button.setAttribute('aria-label', label)
  return button
}

export function createSpeechBar (speech: SpeechController, onClose: () => void): SpeechBar {
  const playPause = iconButton('Play', playIcon(), () => { if (speech.state === 'playing') speech.pause(); else speech.play() })
  const previous = iconButton('Previous paragraph', arrowUpIcon(), () => { speech.previous() })
  const next = iconButton('Next paragraph', arrowDownIcon(), () => { speech.next() })
  const close = iconButton('Stop reading aloud', closeIcon(), onClose)

  const rate = h('select', { className: 'select' })
  rate.setAttribute('aria-label', 'Speed')
  for (const value of RATES) rate.append(h('option', { value: String(value), textContent: `${String(value)}x`, selected: value === speech.rate }))
  rate.addEventListener('change', () => { speech.setRate(Number(rate.value)) })

  const voice = h('select', { className: 'select voice' })
  voice.setAttribute('aria-label', 'Voice')
  voice.addEventListener('change', () => { speech.setVoice(voice.value) })

  const element = h('div', { className: 'speech', hidden: true }, previous, playPause, next, rate, voice, close)
  element.setAttribute('role', 'toolbar')
  element.setAttribute('aria-label', 'Read aloud')

  let listed = ''
  function render (): void {
    const playing = speech.state === 'playing'
    playPause.replaceChildren(playing ? pauseIcon() : playIcon())
    playPause.title = playing ? 'Pause' : 'Play'
    playPause.setAttribute('aria-label', playing ? 'Pause' : 'Play')
    const voices = speech.voices()
    const key = voices.map((entry) => entry.voiceURI).join('|')
    if (key !== listed) {
      listed = key
      voice.replaceChildren(...voices.map((entry) => h('option', { value: entry.voiceURI, textContent: `${entry.name} (${entry.lang})` })))
    }
    if (speech.voiceURI !== null) voice.value = speech.voiceURI
    rate.value = String(speech.rate)
  }

  return {
    element,
    render,
    show: (visible) => { element.hidden = !visible }
  }
}
