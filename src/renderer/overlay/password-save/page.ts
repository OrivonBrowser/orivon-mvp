// The prompt that offers to keep a sign-in: the site, the username (editable when the account is new), the
// password as dots with an eye to see it, and three ways out. It never holds the password: the eye asks
// main, which answers only this prompt. It does not take the keyboard from the page until it is clicked.
import { h } from '../../pages/shared/dom.js'
import { checkIcon, eyeIcon, eyeOffIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { offerFrom, SAVED_MS } from './model.js'
import type { Offer } from './model.js'
import './password-save.css'

/** The dots stand for a password of any length: their count says nothing about it. */
const DOTS = '•'.repeat(10)
const INTERACT_EVERY_MS = 1000

export const passwordSavePage: OverlayPage = {
  mount (content, overlay: Overlay) {
    let offer: Offer | undefined
    let revealed = false
    let taken = false
    let lastInteraction = 0

    const title = h('h1', { className: 'sheet-title', id: 'ps-title' })
    const origin = h('p', { className: 'origin' })
    const username = h('input', { className: 'text', type: 'text', id: 'ps-username', autocomplete: 'off', spellcheck: false })
    const secret = h('span', { className: 'ps-secret', id: 'ps-secret', textContent: DOTS })
    const eye = h('button', { type: 'button', className: 'btn icon ps-eye', ariaLabel: 'Show password', title: 'Show password' }, eyeIcon())
    eye.setAttribute('aria-pressed', 'false')
    const problem = h('p', { className: 'problem', role: 'alert' })
    const never = h('button', { type: 'button', className: 'link-btn', textContent: 'Never for this site' })
    const later = h('button', { type: 'button', className: 'btn', textContent: 'Not now' })
    const save = h('button', { type: 'button', className: 'btn primary', textContent: 'Save' })

    const sheet = h('div', { className: 'ps', role: 'dialog', ariaLabel: 'Save password' },
      title,
      origin,
      h('div', { className: 'sheet-body' },
        h('label', { className: 'field' }, h('span', null, 'Username'), username),
        h('div', { className: 'field' }, h('span', { id: 'ps-secret-label' }, 'Password'), h('div', { className: 'ps-password' }, secret, eye)),
        problem),
      h('div', { className: 'btn-row' }, never, later, save))
    sheet.setAttribute('aria-labelledby', 'ps-title')
    secret.setAttribute('aria-labelledby', 'ps-secret-label')
    content.append(sheet)

    function setRevealed (on: boolean, text?: string): void {
      revealed = on
      secret.textContent = on ? text ?? DOTS : DOTS
      secret.classList.toggle('shown', on)
      eye.replaceChildren(on ? eyeOffIcon() : eyeIcon())
      const label = on ? 'Hide password' : 'Show password'
      eye.setAttribute('aria-label', label)
      eye.title = label
      eye.setAttribute('aria-pressed', String(on))
    }

    /** The first press inside asks main for the keyboard: until then the page the person is working in keeps it. */
    function take (): Promise<unknown> {
      if (taken) return Promise.resolve()
      taken = true
      return overlay.request({ type: 'focus' })
    }

    function interacted (): void {
      const now = Date.now()
      if (now - lastInteraction < INTERACT_EVERY_MS) return
      lastInteraction = now
      void overlay.request({ type: 'interact' })
    }

    sheet.addEventListener('pointerdown', (event) => {
      const field = event.target instanceof HTMLInputElement ? event.target : undefined
      void take().then(() => { field?.focus() })
    }, true)
    for (const type of ['keydown', 'input', 'pointerdown', 'focusin'] as const) sheet.addEventListener(type, interacted)

    eye.addEventListener('click', () => {
      if (revealed) { setRevealed(false); return }
      void overlay.request<{ password?: string } | undefined>({ type: 'reveal' }).then((reply) => {
        if (typeof reply?.password === 'string') setRevealed(true, reply.password)
      })
    })
    never.addEventListener('click', () => { void overlay.request({ type: 'never' }) })
    later.addEventListener('click', () => { void overlay.request({ type: 'dismiss' }) })

    function done (): void {
      content.replaceChildren(h('div', { className: 'toast', role: 'status' },
        h('span', { className: 'ps-done' }, checkIcon()), h('span', null, 'Password saved')))
      setTimeout(() => { overlay.close() }, SAVED_MS)
    }

    function submit (): void {
      if (offer === undefined) return
      save.disabled = true
      problem.textContent = ''
      void overlay.request<{ ok?: boolean } | undefined>({ type: 'save', username: username.value }).then((reply) => {
        if (reply?.ok === true) { done(); return }
        save.disabled = false
        problem.textContent = 'The password could not be saved.'
      })
    }
    save.addEventListener('click', submit)
    username.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      submit()
    })

    // The password button asks for the keyboard on the prompt: Save is where it lands.
    overlay.onEvent((event) => {
      if (typeof event !== 'object' || event === null || (event as { type?: unknown }).type !== 'focus-save') return
      void take().then(() => { save.focus() })
    })

    return {
      shown (payload) {
        offer = offerFrom(payload)
        if (offer === undefined) return
        const update = offer.kind === 'update'
        title.textContent = update ? 'Update password?' : 'Save password?'
        origin.textContent = offer.origin
        origin.title = offer.origin
        username.value = offer.username
        username.readOnly = update
        username.placeholder = 'No username'
        save.textContent = update ? 'Update' : 'Save'
        save.disabled = false
        problem.textContent = ''
        taken = false
        setRevealed(false)
      }
    }
  }
}
