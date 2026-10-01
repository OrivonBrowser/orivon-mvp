// The sheet that asks whether an extension may hold more. Main sends the whole sheet on every show and enforces
// the Allow guard itself; the page only names a button. Focus starts on Deny, and Allow looks disabled for the
// guard's length so a key or click meant for the page has nowhere to land.
import type { PermissionPromptView } from '../../../main/extensions/permission-prompt-overlay.js'
import { h } from '../../pages/shared/dom.js'
import { puzzleIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import './extension-permission.css'

const ID_SHOWN = 12

function isLine (line: unknown): boolean {
  if (typeof line !== 'object' || line === null) return false
  const { words, name } = line as Record<string, unknown>
  return typeof words === 'string' || typeof name === 'string'
}

const isView = (value: unknown): value is PermissionPromptView => {
  if (typeof value !== 'object' || value === null) return false
  const { name, id, icon, lines, guardMs } = value as Record<string, unknown>
  return typeof name === 'string' && typeof id === 'string' && (icon === undefined || typeof icon === 'string') &&
    Array.isArray(lines) && lines.every(isLine) && typeof guardMs === 'number'
}

export const extensionPermissionPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const sheet = h('div', { className: 'sheet perm', role: 'alertdialog' })
    content.append(sheet)
    let guardTimer: ReturnType<typeof setTimeout> | undefined
    const answer = (allow: boolean): void => { void overlay.request({ allow }) }

    return {
      shown (payload) {
        if (!isView(payload)) { overlay.close(); return }
        if (guardTimer !== undefined) clearTimeout(guardTimer)
        const icon = payload.icon === undefined
          ? h('span', { className: 'perm-icon placeholder' }, puzzleIcon())
          : h('img', { className: 'perm-icon', src: payload.icon, alt: '' })
        const list = h('ul', { className: 'perm-lines', id: 'perm-lines' },
          ...payload.lines.map((line) => h('li', null, 'words' in line ? line.words : h('code', { textContent: line.name }))))
        const deny = h('button', { type: 'button', className: 'btn', textContent: 'Deny', onclick: () => { answer(false) } })
        const allow = h('button', { type: 'button', className: 'btn primary', textContent: 'Allow', disabled: payload.guardMs > 0, onclick: () => { answer(true) } })
        sheet.setAttribute('aria-labelledby', 'perm-title')
        sheet.setAttribute('aria-describedby', 'perm-lines')
        sheet.replaceChildren(
          h('div', { className: 'perm-head' },
            icon,
            h('div', { className: 'perm-who' },
              h('h1', { className: 'sheet-title', id: 'perm-title', textContent: `Allow the extension "${payload.name}" to do more?` }),
              h('p', { className: 'origin perm-id', title: payload.id, textContent: `Extension ID ${payload.id.slice(0, ID_SHOWN)}…` }))),
          h('div', { className: 'sheet-body' },
            h('p', { textContent: 'It is asking to:' }),
            list,
            h('p', { className: 'perm-note', textContent: 'You can take this back on the extension\'s details page.' })),
          h('div', { className: 'btn-row' }, deny, allow))
        deny.focus()
        if (payload.guardMs > 0) guardTimer = setTimeout(() => { allow.disabled = false }, payload.guardMs)
        requestAnimationFrame(() => { if (list.scrollHeight > list.clientHeight) list.tabIndex = 0 })
      }
    }
  }
}
