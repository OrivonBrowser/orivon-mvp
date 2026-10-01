// One extension: its name and icon with the on/off switch and Remove, then a
// card per registered section (registry.ts) in order.
import { h, replaceChildren } from '../../shared/dom.js'
import { chevronRightIcon, puzzleIcon } from '../../shared/icons.js'
import { letterTile } from '../../shared/letter-tile.js'
import type { DetailsPayload } from '../state.js'
import type { DetailSection, ExtensionView, PageContext } from '../types.js'
import { pathFor } from '../router.js'
import { removeButton } from './remove-button.js'
import { enabledSwitch } from './switch.js'

function backLink (ctx: PageContext): HTMLElement {
  const href = pathFor('list')
  const arrow = chevronRightIcon()
  arrow.classList.add('flip')
  return h('a', {
    className: 'link-btn back',
    href,
    onclick: (event: MouseEvent) => { event.preventDefault(); ctx.navigate(href) }
  }, arrow, 'All extensions')
}

function head (details: DetailsPayload, ctx: PageContext): HTMLElement {
  const { row } = details
  const icon = row.iconDataUrl === undefined
    ? letterTile(row.name, 'd-icon', 'div')
    : h('img', { className: 'd-icon', src: row.iconDataUrl, alt: '' })
  return h('header', { className: 'd-head' },
    icon,
    h('div', { className: 'd-title' },
      h('h1', { textContent: row.name }),
      h('p', { className: 'd-version', textContent: `Version ${row.version}` }),
      row.description === '' ? null : h('p', { className: 'd-desc', textContent: row.description })),
    h('div', { className: 'd-actions' },
      row.enabled ? null : h('span', { className: 'badge', textContent: 'Off' }),
      enabledSwitch(row, ctx),
      removeButton(row, ctx, () => { ctx.navigate(pathFor('list')) })))
}

function missing (ctx: PageContext): HTMLElement {
  return h('div', { className: 'empty-state' },
    puzzleIcon(),
    h('strong', { textContent: 'This extension is not installed' }),
    h('p', { textContent: 'It may have been removed from another window.' }),
    backLink(ctx))
}

function skeleton (): HTMLElement {
  const loading = h('div', { className: 'd-loading' },
    h('span', { className: 'skeleton line' }), h('span', { className: 'skeleton line short' }), h('span', { className: 'skeleton block' }))
  loading.setAttribute('aria-busy', 'true')
  return loading
}

export function detailsView (sections: readonly DetailSection[]): ExtensionView {
  return {
    render: (root, ctx) => {
      const id = new URLSearchParams(location.search).get('id') ?? ''
      if (root.childElementCount === 0) replaceChildren(root, backLink(ctx), skeleton())
      void ctx.request<{ details: DetailsPayload } | undefined>('details', { id }).then((reply) => {
        if (reply === undefined) { replaceChildren(root, missing(ctx)); return }
        const cards = sections.map((section) => {
          const body = section.render(reply.details, ctx)
          return body === null ? null : h('section', { className: 'card', id: `section-${section.id}` }, h('h2', { textContent: section.title }), body)
        })
        replaceChildren(root, backLink(ctx), head(reply.details, ctx), h('div', { className: 'd-sections' }, ...cards))
      })
    }
  }
}
