// The certificate viewer: one tab per certificate of the chain the page's host presented, and its fields.
// Main reads the chain and copies the PEM; the page draws what it is sent and names a certificate by its place.
import type { CertificatePage } from '../../../main/auth/certificate-overlay.js'
import type { CertificateView, Party } from '../../../main/auth/certificate-view.js'
import { h } from '../../pages/shared/dom.js'
import { lockIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import './certificate.css'

const FEEDBACK_MS = 2000

export function isCertificatePage (value: unknown): value is CertificatePage {
  if (typeof value !== 'object' || value === null) return false
  const { host, chain } = value as Record<string, unknown>
  return typeof host === 'string' && (chain === null || (Array.isArray(chain) && chain.every((item) => typeof item === 'object' && item !== null)))
}

export const formatDate = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** The validity of one end of a certificate's life: its date, and a word when it is outside it. */
export function validityNote (certificate: Pick<CertificateView, 'validFrom' | 'validUntil'>, end: 'from' | 'until', now: number): string | null {
  if (end === 'from') return certificate.validFrom > now ? 'not yet valid' : null
  return certificate.validUntil < now ? 'expired' : null
}

function party (who: Party): HTMLElement {
  return h('span', { className: 'cert-party' },
    h('span', { className: 'cert-name' }, who.commonName === '' ? 'Not part of the certificate' : who.commonName),
    who.organization === '' ? null : h('span', { className: 'cert-org' }, who.organization))
}

export const certificatePage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const card = h('div', { className: 'cert', role: 'dialog' })
    content.append(card)
    let feedback: ReturnType<typeof setTimeout> | undefined

    function close (): HTMLButtonElement {
      const button = h('button', { type: 'button', className: 'btn' }, 'Close')
      button.addEventListener('click', () => { overlay.close() })
      return button
    }

    function empty (host: string): void {
      const reload = h('button', { type: 'button', className: 'btn primary' }, 'Reload')
      reload.addEventListener('click', () => { void overlay.request({ type: 'reload' }) })
      card.replaceChildren(
        h('h1', { className: 'sheet-title', id: 'cert-title' }, `Certificate for ${host}`),
        h('div', { className: 'empty-state compact', role: 'status' }, lockIcon(), h('p', null, 'Reload the page to read its certificate.')),
        h('div', { className: 'btn-row' }, close(), reload))
      card.setAttribute('aria-labelledby', 'cert-title')
      reload.focus()
    }

    function chain (host: string, certificates: readonly CertificateView[]): void {
      let at = 0
      const body = h('div', { className: 'cert-body' })
      const tabs = h('div', { className: 'tabs', role: 'tablist', ariaLabel: 'Certificate chain' })
      const buttons = certificates.map((certificate, index) => {
        const name = certificate.subject.commonName === '' ? `Certificate ${String(index + 1)}` : certificate.subject.commonName
        const button = h('button', { type: 'button', className: 'tab-btn', role: 'tab', title: name, id: `cert-tab-${String(index)}` }, name)
        button.addEventListener('click', () => { select(index) })
        return button
      })
      tabs.append(...buttons)
      tabs.addEventListener('keydown', (event) => {
        const next = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null
        if (next === null || next < 0 || next >= buttons.length) return
        event.preventDefault()
        select(next)
        buttons[next]?.focus()
      })

      function select (index: number): void {
        at = index
        const certificate = certificates[index]
        if (certificate === undefined) return
        buttons.forEach((button, place) => {
          button.setAttribute('aria-selected', String(place === index))
          button.tabIndex = place === index ? 0 : -1
        })
        const now = Date.now()
        const date = (ms: number, note: string | null): HTMLElement =>
          h('span', { className: note === null ? '' : 'cert-bad' }, formatDate(ms), note === null ? null : ` (${note})`)
        const status = h('span', { className: 'cert-status', role: 'status' })
        const copy = h('button', { type: 'button', className: 'link-btn' }, 'Copy PEM')
        copy.addEventListener('click', () => {
          void overlay.request<{ ok?: boolean } | undefined>({ type: 'copyPem', index }).then((reply) => {
            status.textContent = reply?.ok === true ? 'Copied' : 'Could not copy'
            if (feedback !== undefined) clearTimeout(feedback)
            feedback = setTimeout(() => { status.textContent = '' }, FEEDBACK_MS)
          })
        })
        body.setAttribute('role', 'tabpanel')
        body.setAttribute('aria-labelledby', `cert-tab-${String(index)}`)
        body.replaceChildren(
          h('dl', { className: 'cert-grid' },
            h('dt', null, 'Issued to'), h('dd', null, party(certificate.subject)),
            h('dt', null, 'Issued by'), h('dd', null, party(certificate.issuer)),
            h('dt', null, 'Valid from'), h('dd', null, date(certificate.validFrom, validityNote(certificate, 'from', now))),
            h('dt', null, 'Valid until'), h('dd', null, date(certificate.validUntil, validityNote(certificate, 'until', now))),
            h('dt', null, 'Serial number'), h('dd', { className: 'cert-mono' }, certificate.serial),
            h('dt', null, 'SHA-256 fingerprint'), h('dd', { className: 'cert-mono' }, certificate.fingerprint)),
          h('div', { className: 'cert-actions' }, copy, status))
      }

      card.setAttribute('aria-labelledby', 'cert-title')
      card.replaceChildren(
        h('h1', { className: 'sheet-title', id: 'cert-title' }, `Certificate for ${host}`),
        tabs,
        body,
        h('div', { className: 'btn-row' }, close()))
      select(0)
      buttons[0]?.focus()
    }

    return {
      shown (payload) {
        if (!isCertificatePage(payload)) { overlay.close(); return }
        if (payload.chain === null || payload.chain.length === 0) empty(payload.host)
        else chain(payload.host, payload.chain)
      }
    }
  }
}
