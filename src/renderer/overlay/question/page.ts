// The panel every question is drawn in. Main sends the whole question on each
// show and enforces the guard itself, counting from the page's report that the
// question is drawn; the page only names a button. A
// consent question starts focus on the panel, never a button, so Enter
// accepts nothing; a guarded button looks disabled for the guard's length.
import { h, replaceChildren } from '../../pages/shared/dom.js'
import type { Overlay, OverlayPage } from '../kit.js'
import type { QuestionView } from '../../../main/shell/question/question-spec.js'
import { displayOrder, isPageQuestion, isQuestionView, primaryIndex } from './view.js'
import './question.css'

export const questionPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const root = h('div', { className: 'q', tabIndex: -1 })
    root.setAttribute('role', 'alertdialog')
    content.append(root)
    let armTimer: ReturnType<typeof setTimeout> | undefined
    let guardMs = 0
    let drawing = 0

    /** Buttons look not ready, and a guarded one is not sent, for the guard's length from now. */
    function arm (): void {
      clearTimeout(armTimer)
      if (guardMs <= 0) return
      root.classList.add('arming')
      armTimer = setTimeout(() => { root.classList.remove('arming') }, guardMs)
    }

    /** Main starts its clock when it takes this report, so the page's own look-ready timer starts from the reply, never before it. */
    function reportDrawn (id: string): void {
      clearTimeout(armTimer)
      if (guardMs <= 0) return
      root.classList.add('arming')
      const mine = ++drawing
      void overlay.request({ type: 'drawn', id }).then(() => { if (mine === drawing) arm() }, () => { if (mine === drawing) arm() })
    }

    overlay.onEvent((event) => {
      if (typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'arm') arm()
    })

    function draw (view: QuestionView): void {
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
        text = h('input', { type: 'text', className: 'q-input', value: view.input.initial })
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
