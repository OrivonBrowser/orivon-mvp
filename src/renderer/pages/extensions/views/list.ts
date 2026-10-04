// The list of installed extensions: one card each, with its on/off switch,
// Remove and a link to its details, above the install controls.
import { internalBridge } from '../../shared/bridge.js'
import { h, replaceChildren } from '../../shared/dom.js'
import { puzzleIcon } from '../../shared/icons.js'
import { redrawKeepingFocus } from '../../shared/keep-focus.js'
import { letterTile } from '../../shared/letter-tile.js'
import type { ExtensionRow, InstallReply } from '../state.js'
import type { CardBadge, ExtensionView, PageContext } from '../types.js'
import { pathFor } from '../router.js'
import { removeButton } from './remove-button.js'
import { enabledSwitch } from './switch.js'

/** Why the last install or load failed; kept across a redraw, cleared by the next attempt. */
let message: string | null = null

function card (ext: ExtensionRow, ctx: PageContext, badges: readonly CardBadge[]): HTMLElement {
  const icon = ext.iconDataUrl === undefined
    ? letterTile(ext.name, 'ext-icon', 'div')
    : h('img', { className: 'ext-icon', src: ext.iconDataUrl, alt: '' })
  const href = pathFor('details', ext.id)
  const details = h('a', {
    className: 'link-btn',
    href,
    textContent: 'Details',
    onclick: (event: MouseEvent) => { event.preventDefault(); ctx.navigate(href) }
  })
  details.setAttribute('aria-label', `Details of ${ext.name}`)
  details.dataset['focus'] = `${ext.id}:details`
  return h('section', { className: ext.enabled ? 'ext-card' : 'ext-card off' },
    h('div', { className: 'ext-row' },
      icon,
      h('div', { className: 'ext-main' },
        h('div', { className: 'ext-name-line' },
          h('strong', { className: 'ext-name', textContent: ext.name }),
          h('span', { className: 'ext-version', textContent: ext.version }),
          ...badges.map((badge) => badge.render(ext, ctx))),
        ext.description === '' ? null : h('p', { className: 'ext-desc', textContent: ext.description }),
        details),
      enabledSwitch(ext, ctx),
      removeButton(ext, ctx, ctx.refresh)))
}

function emptyState (): HTMLElement {
  return h('div', { className: 'empty-state' },
    puzzleIcon(),
    h('strong', { textContent: 'No extensions installed' }),
    h('p', { textContent: 'Install one from the Chrome Web Store, or from a file on this computer.' }))
}

function skeleton (): HTMLElement {
  const list = h('div', { className: 'ext-list' },
    ...[0, 1].map(() => h('div', { className: 'ext-card' }, h('span', { className: 'skeleton line' }), h('span', { className: 'skeleton line short' }))))
  list.setAttribute('aria-busy', 'true')
  return list
}

function actions (ctx: PageContext, redraw: () => void): HTMLElement {
  const devInput = h('input', {
    type: 'checkbox',
    checked: ctx.developerMode,
    onchange: () => { void internalBridge().request('settings', { type: 'set', key: 'extensions.developerMode', value: devInput.checked }) }
  })
  devInput.setAttribute('aria-label', 'Developer mode')
  devInput.dataset['focus'] = 'developer-mode'
  const after = (outcome: InstallReply): void => {
    message = outcome.installed || outcome.reason === 'cancelled' ? null : (outcome.reason ?? 'That could not be installed.')
    redraw()
  }
  return h('div', { className: 'list-bar' },
    h('label', { className: 'dev-mode-row' }, h('span', { textContent: 'Developer mode' }), h('span', { className: 'switch' }, devInput, h('span', { className: 'track' }))),
    h('div', { className: 'list-buttons' },
      ctx.developerMode ? h('button', { className: 'btn', type: 'button', textContent: 'Load unpacked', onclick: () => { void ctx.request<InstallReply>('loadUnpacked').then(after) } }) : null,
      h('button', { className: 'btn primary', type: 'button', textContent: 'Install from file…', onclick: () => { void ctx.request<InstallReply>('installFromFile').then(after) } })))
}

export function listView (badges: readonly CardBadge[]): ExtensionView {
  return {
    render: (root, ctx) => {
      const redraw = (): void => { ctx.refresh() }
      if (ctx.isPrivate) {
        replaceChildren(root, h('div', { className: 'banner info', role: 'status', textContent: 'Extensions do not run in private or guest windows.' }))
        return
      }
      if (root.childElementCount === 0) replaceChildren(root, skeleton())
      void ctx.request<{ rows: readonly ExtensionRow[] }>('list').then(({ rows }) => {
        redrawKeepingFocus(root, () => {
          replaceChildren(root,
            actions(ctx, redraw),
            message === null ? null : h('div', { className: 'banner error', role: 'alert', textContent: message }),
            rows.length === 0 ? emptyState() : h('div', { className: 'ext-list' }, ...rows.map((ext) => card(ext, ctx, badges))),
            h('a', { className: 'store-link link-btn', href: 'https://chromewebstore.google.com/category/extensions', target: '_blank', rel: 'noopener', textContent: 'Get more extensions from the Chrome Web Store' }))
        })
      })
    }
  }
}
