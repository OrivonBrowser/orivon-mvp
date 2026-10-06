// The panel every question is drawn in. Main sends the whole question on each
// show and enforces the guard itself, counting from the page's report that the
// question is drawn and from the last key pressed in the panel; the page only
// names a button. A consent question starts focus on the panel, never a
// button; a guarded button looks disabled for the guard's length.
import { h, replaceChildren } from '../../pages/shared/dom.js'
import type { Overlay, OverlayPage } from '../kit.js'
import type { QuestionView } from '../../../main/shell/question/question-spec.js'
import { createArrival } from './arrival.js'
import { displayOrder, isPageQuestion, isQuestionView, primaryIndex } from './view.js'
import './question.css'

/** What a double-press button says once it has been pressed and waits for the second press. */
const AGAIN_LABEL = 'Press again'

export const questionPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const root = h('div', { className: 'q', tabIndex: -1 })
    root.setAttribute('role', 'alertdialog')
    content.append(root)
    let armTimer: ReturnType<typeof setTimeout> | undefined
    let guardMs = 0
    let drawing = 0
    let arrivals: Array<ReturnType<typeof createArrival>> = []

    /** Buttons look not ready, and a guarded one is not sent, for the guard's length from now. */
    function arm (): void {
      clearTimeout(armTimer)
      for (const arrival of arrivals) arrival.restarted()
      if (guardMs <= 0) return
      root.classList.add('arming')
      armTimer = setTimeout(() => {
        root.classList.remove('arming')
        for (const arrival of arrivals) arrival.guardEnded()
      }, guardMs)
    }

    /** Main starts its clock when it takes this report, so the page's own look-ready timer starts from the reply, never before it. */
    function reportDrawn (id: string): void {
      clearTimeout(armTimer)
      if (guardMs <= 0) return
      root.classList.add('arming')
      const mine = ++drawing
      void overlay.request({ type: 'drawn', id }).then(() => { if (mine === drawing) arm() }, () => { if (mine === drawing) arm() })
    }

    let showing: QuestionView | undefined
    let pressedTimer: ReturnType<typeof setTimeout> | undefined
    const buttonFor = (index: number): HTMLElement | null => root.querySelector<HTMLElement>(`[data-button="${String(index)}"]`)

    /** A double-press button shows its own label again: no second press came in time, or the pointer left. */
    function restoreLabel (index: number): void {
      clearTimeout(pressedTimer)
      const button = buttonFor(index)
      if (button === null || showing === undefined) return
      button.classList.remove('pressed')
      button.textContent = showing.buttons[index] ?? ''
    }

    overlay.onEvent((event) => {
      const kind = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined
      if (kind === 'arm') {
        arm()
        for (const index of showing?.doublePress ?? []) restoreLabel(index)
      }
      if (kind === 'pressed') {
        const { button: index, ms } = event as { button?: unknown, ms?: unknown }
        const button = typeof index === 'number' ? buttonFor(index) : null
        if (button === null || typeof index !== 'number' || typeof ms !== 'number') return
        button.classList.add('pressed')
        button.textContent = AGAIN_LABEL
        clearTimeout(pressedTimer)
        pressedTimer = setTimeout(() => { restoreLabel(index) }, ms)
      }
    })

    /** Tells main when the pointer or the focus arrives on a double-press button, and when it leaves: main arms it only then, after the guard. */
    function watchArrival (id: string, index: number, button: HTMLElement): void {
      const arrival = createArrival({
        send: (type) => { void overlay.request({ type, id, button: index }) },
        isArming: () => root.classList.contains('arming'),
        isOver: () => button.matches(':hover') || document.activeElement === button,
        left: () => { restoreLabel(index) }
      })
      arrivals.push(arrival)
      // A move inside the button counts as arriving: a pointer that rested on it through the guard only has to move to arm it.
      button.addEventListener('pointermove', arrival.arrive)
      button.addEventListener('pointerenter', arrival.arrive)
      button.addEventListener('focus', arrival.arrive)
      button.addEventListener('pointerleave', arrival.leave)
      button.addEventListener('blur', arrival.leave)
    }

    function draw (view: QuestionView): void {
      showing = view
      arrivals = []
      clearTimeout(pressedTimer)
      const page = isPageQuestion(view.kind)
      let text: HTMLInputElement | undefined
      let tick: HTMLInputElement | undefined
      const answer = (button: number): void => {
        if (view.guarded.includes(button) && root.classList.contains('arming')) return
        void overlay.request({
          id: view.id,
          button,
          ...(text === undefined ? {} : { text: text.value }),
          ...(tick === undefined ? {} : { checkbox: tick.checked })
        })
      }
      if (view.input !== undefined) {
        // As long as main takes an answer: longer, OK would be refused with nothing on screen to say why.
        text = h('input', { type: 'text', className: 'q-input', value: view.input.initial, maxLength: view.input.max })
        text.setAttribute('aria-label', view.message)
        text.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return
          const accept = primaryIndex(view.buttons, view.cancelId)
          if (accept >= 0) answer(accept)
        })
      }
      if (view.checkboxLabel !== undefined) tick = h('input', { type: 'checkbox' })
      const buttons = displayOrder(view.buttons, view.cancelId).map((index) => {
        const button = h('button', {
          type: 'button',
          className: `btn${index === primaryIndex(view.buttons, view.cancelId) ? ' primary' : ''}${view.guarded.includes(index) ? ' guarded' : ''}`,
          onclick: () => { answer(index) }
        }, view.buttons[index] ?? '')
        button.dataset['button'] = String(index)
        if (view.doublePress.includes(index)) watchArrival(view.id, index, button)
        return button
      })
      root.className = `q ${page ? 'q-page' : 'q-browser'}${view.warning ? ' q-warning' : ''}`
      root.dataset['kind'] = view.kind
      root.setAttribute('aria-labelledby', 'q-message')
      root.setAttribute('aria-describedby', 'q-detail')
      replaceChildren(root,
        h('p', { className: 'origin q-origin' }, page ? `${view.origin ?? 'This page'} says` : view.origin ?? ''),
        view.title !== undefined && h('h1', { className: 'sheet-title q-title' }, view.title),
        h('p', { className: 'q-message', id: 'q-message' }, view.message),
        view.detail !== undefined && h('p', { className: 'q-detail', id: 'q-detail' }, view.detail),
        text,
        tick !== undefined && h('label', { className: 'check q-check' }, tick, h('span', null, view.checkboxLabel ?? '')),
        h('div', { className: 'btn-row' }, ...buttons))
      if (!page && view.origin === undefined) root.querySelector('.q-origin')?.remove()
      guardMs = view.guarded.length > 0 ? view.guardMs : 0
      reportDrawn(view.id)
      if (view.focus === 'dialog') root.focus()
      else if (text !== undefined) { text.focus(); text.select() }
      else root.querySelector<HTMLElement>(`[data-button="${view.focus}"]`)?.focus()
    }

    return {
      shown (payload) {
        if (!isQuestionView(payload)) { overlay.close(); return }
        draw(payload)
      }
    }
  }
}
