// The permission prompt and the bubble under its chip. Main sends everything
// that is drawn (the site, what it wants, the current answers) and decides
// what each button does; the page only names a button.
import type { AskView, ReviewRow, ReviewView } from '../../../main/site-settings/site-prompt-text.js'
import { h, replaceChildren } from '../../pages/shared/dom.js'
import { closeIcon } from '../../pages/shared/icons.js'
import { SITE_KIND_ICONS } from '../../pages/shared/site-kind-icons.js'
import type { SiteKind } from '../../../main/site-settings/kinds.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { ARMING_MS, isAskView, isReviewView, segmentAfterKey } from './view.js'
import './site-prompt.css'

type Choice = 'ask' | 'allow' | 'block'
const CHOICES: ReadonlyArray<{ value: Choice, label: string }> = [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }, { value: 'block', label: 'Block' }]

function iconOf (kind: string): SVGSVGElement | null {
  return Object.hasOwn(SITE_KIND_ICONS, kind) ? SITE_KIND_ICONS[kind as SiteKind]() : null
}

export const sitePromptPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const root = h('div', { className: 'site-prompt', tabIndex: -1 })
    root.setAttribute('role', 'dialog')
    content.append(root)
    let shownAt = 0
    let reviewing = false
    let armTimer: ReturnType<typeof setTimeout> | undefined

    // The bubble closes when the person goes elsewhere; a question stays until it is answered.
    window.addEventListener('blur', () => { if (reviewing) overlay.closeOnBlur() })

    const armed = (): boolean => performance.now() - shownAt >= ARMING_MS

    function drawAsk (view: AskView): void {
      const answer = (value: 'allow' | 'block'): void => {
        if (armed()) void overlay.request({ type: 'answer', id: view.id, answer: value })
      }
      const block = h('button', { type: 'button', className: 'btn', onclick: () => { answer('block') } }, 'Block')
      const allow = h('button', { type: 'button', className: 'btn primary', onclick: () => { answer('allow') } }, 'Allow')
      const close = h('button', { type: 'button', className: 'btn icon sp-close', onclick: () => { overlay.close() } }, closeIcon())
      close.setAttribute('aria-label', 'Not now')
      close.title = 'Not now'
      const lines = view.lines.map((line) => h('p', { className: 'sp-ask' },
        h('span', { className: 'sp-icons', ariaHidden: 'true' }, ...line.kinds.map(iconOf)),
        h('span', { className: 'sp-text' }, line.text)))
      root.classList.remove('review')
      root.classList.add('arming')
      root.setAttribute('aria-labelledby', 'sp-origin')
      root.setAttribute('aria-describedby', 'sp-asks')
      replaceChildren(root,
        h('p', { className: 'origin', id: 'sp-origin' }, view.origin),
        h('div', { className: 'sp-asks', id: 'sp-asks' }, ...lines),
        view.locationNote !== null && h('div', { className: 'banner info', role: 'note' }, view.locationNote),
        h('div', { className: 'btn-row' }, block, allow),
        view.privateNote !== null && h('p', { className: 'sp-note' }, view.privateNote),
        close
      )
      clearTimeout(armTimer)
      armTimer = setTimeout(() => { root.classList.remove('arming') }, ARMING_MS)
    }

    function drawReview (view: ReviewView, changed: boolean): void {
      const rows = view.rows.map((row) => reviewRow(row))
      const footer: Array<HTMLElement | false> = [
        changed && h('div', { className: 'banner info sp-reload', role: 'status' },
          h('span', null, 'Reload the page to apply.'),
          h('button', { type: 'button', className: 'btn small', onclick: () => { void overlay.request({ type: 'reload' }) } }, 'Reload')),
        view.settingsLink && h('div', { className: 'sp-foot' },
          h('button', { type: 'button', className: 'link-btn', onclick: () => { void overlay.request({ type: 'settings' }) } }, 'Site settings'))
      ]
      root.classList.add('review')
      root.classList.remove('arming')
      root.setAttribute('aria-labelledby', 'sp-title')
      root.removeAttribute('aria-describedby')
      replaceChildren(root,
        h('h1', { className: 'sheet-title', id: 'sp-title' }, 'Permissions on this page'),
        h('p', { className: 'origin' }, view.origin),
        h('ul', { className: 'sp-rows' }, ...rows),
        ...footer
      )

      function reviewRow (row: ReviewRow): HTMLElement {
        const buttons = CHOICES.map((choice) => {
          const button = h('button', {
            type: 'button',
            disabled: choice.value === 'ask' && !row.askOffered,
            onclick: () => {
              void overlay.request<{ kind: string, value: Choice } | undefined>({ type: 'set', kind: row.kind, value: choice.value }).then((done) => {
                if (done === undefined) return
                const next = view.rows.map((other) => other.kind === row.kind ? { ...other, value: done.value } : other)
                drawReview({ ...view, rows: next }, true)
                focusSegment(row.kind, done.value)
              })
            }
          }, choice.label)
          button.setAttribute('aria-pressed', String(choice.value === row.value))
          button.dataset['value'] = choice.value
          return button
        })
        const group = h('div', { className: 'segmented', role: 'group' }, ...buttons)
        group.setAttribute('aria-label', `${row.label} on this page`)
        group.dataset['kind'] = row.kind
        group.addEventListener('keydown', (event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          const enabled = buttons.filter((button) => !button.disabled)
          const at = enabled.findIndex((button) => button === document.activeElement)
          if (at < 0) return
          event.preventDefault()
          enabled[segmentAfterKey(at, event.key, enabled.length)]?.focus()
        })
        return h('li', { className: 'sp-row' },
          h('span', { className: 'sp-kind' }, h('span', { className: 'sp-icons', ariaHidden: 'true' }, iconOf(row.kind)), h('span', { className: 'sp-label' }, row.label)),
          group)
      }

      function focusSegment (kind: string, value: Choice): void {
        root.querySelector<HTMLElement>(`.segmented[data-kind="${kind}"] [data-value="${value}"]`)?.focus()
      }
    }

    return {
      shown (payload) {
        shownAt = performance.now()
        if (isAskView(payload)) {
          reviewing = false
          drawAsk(payload)
        } else if (isReviewView(payload)) {
          reviewing = true
          drawReview(payload, false)
        } else {
          overlay.close()
          return
        }
        // Focus goes to the dialog, never a button: a key typed at the page cannot answer.
        root.focus()
      }
    }
  }
}
