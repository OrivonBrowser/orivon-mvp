// The first section of the details view: where the extension came from, who
// updates it, what it may reach, and the actions that follow from those.
import { h } from '../../shared/dom.js'
import type { DetailSection } from '../types.js'
import type { DetailsPayload, InstallReply } from '../state.js'
import type { PageContext } from '../types.js'

function detailRow (label: string, value: string, mono = false): HTMLElement {
  return h('div', { className: 'detail-row' },
    h('span', { className: 'detail-label', textContent: label }),
    h('span', { className: mono ? 'detail-value mono' : 'detail-value', textContent: value }))
}

function actions (details: DetailsPayload, ctx: PageContext): HTMLElement | null {
  const done = (outcome: InstallReply): void => { if (outcome.installed) ctx.refresh() }
  const buttons = [
    ctx.developerMode && details.reloadable
      ? h('button', { className: 'btn small', type: 'button', textContent: 'Reload', onclick: () => { void ctx.request<InstallReply>('reload', { id: details.id }).then(done) } })
      : null,
    details.isStoreManaged
      ? h('button', { className: 'btn small', type: 'button', textContent: 'Check for updates', onclick: () => { void ctx.request('checkForUpdates').then(ctx.refresh) } })
      : null,
    details.updateAvailable
      ? h('button', { className: 'btn small primary', type: 'button', textContent: 'Update', onclick: () => { void ctx.request<InstallReply>('updateNow', { id: details.id }).then(done) } })
      : null
  ]
  return buttons.every((button) => button === null) ? null : h('div', { className: 'detail-actions' }, ...buttons)
}

export const aboutSection: DetailSection = {
  id: 'about',
  title: 'About',
  order: 10,
  render: (details, ctx) => {
    const strippedBlock = details.stripped.length === 0 ? null : h('div', { className: 'detail-block' },
      h('span', { className: 'detail-label', textContent: 'Not available in Orivon yet' }),
      h('ul', { className: 'stripped-list' }, ...details.stripped.map((line) => h('li', { textContent: line }))))
    return h('div', { className: 'ext-details' },
      detailRow('ID', details.id, true),
      detailRow('Source', details.source),
      detailRow('Updates', details.updates),
      details.siteAccess === undefined ? null : detailRow('Site access', details.siteAccess),
      detailRow('Where it runs', details.whereItRuns),
      strippedBlock,
      actions(details, ctx))
  }
}
