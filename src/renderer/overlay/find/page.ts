// The find bar: one input, the count, previous and next, match case and close.
// It keeps no search state but the text. Main does the searching and says how
// many matches there are; every keystroke asks for a new search.
import type { FindEvent, FindShown } from '../../../main/find/find-events.js'
import { h } from '../../pages/shared/dom.js'
import { arrowDownIcon, arrowUpIcon, closeIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { countText } from './count.js'
import './find.css'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function asShown (payload: unknown): FindShown {
  if (!isRecord(payload)) return { query: '', matchCase: false, fresh: true }
  return { query: typeof payload['query'] === 'string' ? payload['query'] : '', matchCase: payload['matchCase'] === true, fresh: payload['fresh'] !== false }
}

function asEvent (event: unknown): FindEvent | undefined {
  if (!isRecord(event)) return undefined
  if (event['type'] === 'reset') return { type: 'reset' }
  const { active, total } = event
  if (event['type'] === 'result' && typeof active === 'number' && typeof total === 'number') return { type: 'result', active, total }
  return undefined
}

export const findPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    /** The matches of the search on screen; null while none has answered. */
    let counted: { active: number, total: number } | null = null

    const input = h('input', {
      className: 'text find-input', type: 'text', spellcheck: false, placeholder: 'Find in page', ariaLabel: 'Find in page', autocomplete: 'off'
    })
    const count = h('span', { className: 'find-count', role: 'status' })
    count.setAttribute('aria-live', 'polite')
    const previous = h('button', { type: 'button', className: 'btn icon', ariaLabel: 'Previous match (Shift+Enter)', title: 'Previous match (Shift+Enter)', disabled: true }, arrowUpIcon())
    const next = h('button', { type: 'button', className: 'btn icon', ariaLabel: 'Next match (Enter)', title: 'Next match (Enter)', disabled: true }, arrowDownIcon())
    const matchCase = h('button', { type: 'button', className: 'chip find-case', title: 'Match case' }, 'Aa')
    matchCase.setAttribute('aria-pressed', 'false')
    matchCase.setAttribute('aria-label', 'Match case')
    const close = h('button', { type: 'button', className: 'btn icon', ariaLabel: 'Close (Esc)', title: 'Close (Esc)' }, closeIcon())
    content.append(h('div', { className: 'findbar', role: 'search' }, input, count, previous, next, matchCase, close))

    const caseOn = (): boolean => matchCase.getAttribute('aria-pressed') === 'true'

    function render (): void {
      const text = countText(input.value, counted)
      count.textContent = text
      count.title = text
      const none = counted === null || counted.total === 0
      previous.disabled = none
      next.disabled = none
      if (input.value !== '' && counted !== null && counted.total === 0) input.setAttribute('aria-invalid', 'true')
      else input.removeAttribute('aria-invalid')
    }

    function search (): void {
      if (input.value === '') counted = null
      void overlay.request({ type: 'query', text: input.value, matchCase: caseOn() })
      render()
    }

    function step (forward: boolean): void {
      if (input.value === '' || counted?.total === 0) return
      void overlay.request({ type: 'step', forward })
    }

    input.addEventListener('input', search)
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      step(!event.shiftKey)
    })
    previous.addEventListener('click', () => { step(false) })
    next.addEventListener('click', () => { step(true) })
    matchCase.addEventListener('click', () => {
      matchCase.setAttribute('aria-pressed', String(!caseOn()))
      search()
      input.focus()
    })
    close.addEventListener('click', () => { overlay.close() })

    overlay.onEvent((raw) => {
      const event = asEvent(raw)
      if (event === undefined) return
      counted = event.type === 'result' ? { active: event.active, total: event.total } : null
      render()
    })

    return {
      shown (payload) {
        const shown = asShown(payload)
        input.value = shown.query
        matchCase.setAttribute('aria-pressed', String(shown.matchCase))
        if (shown.fresh) counted = null
        render()
        input.focus()
        input.select()
      }
    }
  }
}
