// The sign-in sheet: who is asking, what they will learn, and two fields. Main sends every string on each show
// and decides what an answer does; the page only names the challenge and what was typed.
import type { AuthView } from '../../../main/auth/auth-text.js'
import { h, replaceChildren } from '../../pages/shared/dom.js'
import { eyeIcon, eyeOffIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import './auth-sheet.css'

export const RETRY_TEXT = 'That username or password was not accepted.'

const isText = (value: unknown): value is string => typeof value === 'string'
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'

export function isAuthView (value: unknown): value is AuthView {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return isText(v['id']) && isText(v['title']) && isText(v['origin']) && isText(v['line']) && isTextOrNull(v['realm']) &&
    isTextOrNull(v['mismatch']) && isTextOrNull(v['insecure']) && typeof v['retry'] === 'boolean' && isText(v['username']) &&
    isTextOrNull(v['saved']) && typeof v['canRemember'] === 'boolean'
}

export const authSheetPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const card = h('form', { className: 'auth', role: 'dialog', noValidate: true })
    content.append(card)

    function build (view: AuthView): HTMLInputElement {
      const username = h('input', { className: 'text', type: 'text', id: 'auth-username', autocomplete: 'off', spellcheck: false, value: view.username })
      username.setAttribute('autocapitalize', 'off')
      const password = h('input', { className: 'text', type: 'password', id: 'auth-password', autocomplete: 'off' })
      if (view.saved !== null) password.placeholder = 'Saved password'
      const reveal = h('button', { type: 'button', className: 'btn icon', title: 'Show password' }, eyeIcon())
      reveal.setAttribute('aria-label', 'Show password')
      reveal.setAttribute('aria-pressed', 'false')
      reveal.addEventListener('click', () => {
        const showing = password.type === 'password'
        password.type = showing ? 'text' : 'password'
        const label = showing ? 'Hide password' : 'Show password'
        reveal.title = label
        reveal.setAttribute('aria-label', label)
        reveal.setAttribute('aria-pressed', String(showing))
        reveal.replaceChildren(showing ? eyeOffIcon() : eyeIcon())
      })
      const remember = view.canRemember ? h('input', { type: 'checkbox', id: 'auth-remember' }) : null
      const cancel = h('button', { type: 'button', className: 'btn' }, 'Cancel')
      const submit = h('button', { type: 'submit', className: 'btn primary' }, 'Sign in')
      let sending = false
      const usesSaved = (): boolean => view.saved !== null && password.value === '' && username.value === view.saved
      const refresh = (): void => { submit.disabled = sending || (username.value === '' && password.value === '') }
      username.addEventListener('input', refresh)
      password.addEventListener('input', refresh)
      refresh()

      cancel.addEventListener('click', () => { void overlay.request({ type: 'cancel', id: view.id }) })
      card.onsubmit = (event) => {
        event.preventDefault()
        if (submit.disabled) return
        sending = true
        refresh()
        void overlay.request({
          type: 'submit', id: view.id, username: username.value, password: password.value,
          remember: remember?.checked === true, useSaved: usesSaved()
        }).finally(() => { sending = false; refresh() })
      }

      const banners = [
        view.mismatch === null ? null : h('p', { className: 'banner warn', role: 'alert' }, view.mismatch),
        view.insecure === null ? null : h('p', { className: 'banner warn', role: 'alert' }, view.insecure)
      ]
      card.setAttribute('aria-labelledby', 'auth-title')
      card.setAttribute('aria-describedby', 'auth-line')
      replaceChildren(card,
        h('h1', { className: 'sheet-title', id: 'auth-title' }, view.title),
        h('p', { className: 'origin', title: view.origin }, view.origin),
        h('p', { className: 'auth-line', id: 'auth-line' }, view.line),
        view.realm === null ? null : h('p', { className: 'auth-realm', title: view.realm }, `The site calls this area "${view.realm}".`),
        ...banners,
        h('div', { className: 'sheet-body' },
          h('div', { className: 'field' }, h('label', { htmlFor: 'auth-username' }, 'Username'), username),
          h('div', { className: 'field' }, h('label', { htmlFor: 'auth-password' }, 'Password'), h('div', { className: 'auth-password' }, password, reveal),
            view.retry ? h('p', { className: 'problem', role: 'alert' }, RETRY_TEXT) : null),
          remember === null ? null : h('label', { className: 'check' }, remember, h('span', null, 'Remember this password'))
        ),
        h('div', { className: 'btn-row' }, cancel, submit)
      )
      return view.username === '' ? username : password
    }

    return {
      shown (payload) {
        if (!isAuthView(payload)) { overlay.close(); return }
        build(payload).focus()
      }
    }
  }
}
