// The "Create shortcut" sheet: the site, the name the shortcut will have, and, in another profile than the default,
// whether the shortcut opens the site there. What is made and where is main's: the sheet only asks, then says how it went.
import { h } from '../../pages/shared/dom.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { resultWords } from './words.js'
import type { Result } from './words.js'
import './shortcut-sheet.css'

interface Shown {
  readonly origin: string
  readonly name: string
  readonly maxName: number
  readonly profileName?: string
}

const isShown = (value: unknown): value is Shown => typeof value === 'object' && value !== null && typeof (value as Shown).origin === 'string' && typeof (value as Shown).name === 'string'

export const shortcutSheetPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const origin = h('p', { className: 'origin' })
    const name = h('input', { className: 'text', type: 'text', autocomplete: 'off', spellcheck: false })
    const profile = h('input', { type: 'checkbox', checked: true })
    const profileRow = h('label', { className: 'check' }, profile, h('span', {}, 'Open in this profile'))
    const body = h('div', { className: 'sheet-body' },
      h('label', { className: 'field' }, h('span', {}, 'Name'), name),
      profileRow)
    const cancel = h('button', { type: 'button', className: 'btn' }, 'Cancel')
    const create = h('button', { type: 'button', className: 'btn primary' }, 'Create')
    const buttons = h('div', { className: 'btn-row' }, cancel, create)
    content.append(h('div', { className: 'shortcut-sheet', role: 'dialog', ariaLabel: 'Create shortcut' },
      h('h1', { className: 'sheet-title' }, 'Create shortcut'),
      origin, body, buttons))
    let busy = false

    function finish (result: Result | undefined): void {
      const { tone, text } = resultWords(result)
      const done = h('button', { type: 'button', className: 'btn primary' }, 'Done')
      done.addEventListener('click', () => { overlay.close() })
      body.replaceChildren(h('div', { className: `banner ${tone}`, role: tone === 'error' ? 'alert' : 'status' }, text))
      buttons.replaceChildren(...(tone === 'error' ? [cancel, create] : [done]))
      cancel.textContent = 'Close'
      busy = false
      create.disabled = false
      create.textContent = 'Try again'
      if (tone === 'ok') done.focus()
      else create.focus()
    }

    function submit (): void {
      if (busy) return
      busy = true
      create.disabled = true
      create.textContent = 'Creating…'
      void overlay.request<Result | undefined>({ type: 'create', name: name.value, thisProfile: profileRow.hidden ? false : profile.checked })
        .then(finish, () => { finish(undefined) })
    }

    cancel.addEventListener('click', () => { overlay.close() })
    create.addEventListener('click', submit)
    name.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } })

    return {
      shown (payload) {
        if (!isShown(payload)) { overlay.close(); return }
        busy = false
        origin.textContent = payload.origin
        name.value = payload.name
        name.maxLength = payload.maxName
        profileRow.hidden = payload.profileName === undefined
        profile.checked = true
        create.disabled = false
        create.textContent = 'Create'
        cancel.textContent = 'Cancel'
        buttons.replaceChildren(cancel, create)
        body.replaceChildren(h('label', { className: 'field' }, h('span', {}, 'Name'), name), profileRow)
        name.focus()
        name.select()
      }
    }
  }
}
