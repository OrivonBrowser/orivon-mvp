// The button that forgets everything: the first click arms it, a second within a few seconds does it.
import { h } from '../shared/dom.js'

const ARMED_MS = 4000
const LABEL = 'Clear all history'

export function createClearAll (onClear: () => void): HTMLButtonElement {
  let disarm: ReturnType<typeof setTimeout> | undefined
  const button = h('button', { className: 'btn danger', type: 'button', textContent: LABEL })
  const reset = (): void => {
    clearTimeout(disarm)
    disarm = undefined
    button.textContent = LABEL
    button.classList.remove('armed')
  }
  button.addEventListener('click', () => {
    if (disarm !== undefined) {
      reset()
      onClear()
      return
    }
    button.textContent = 'Click again to clear'
    button.classList.add('armed')
    disarm = setTimeout(reset, ARMED_MS)
  })
  return button
}
