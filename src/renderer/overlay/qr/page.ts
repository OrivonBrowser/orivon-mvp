// The QR sheet: the address of the page as a code, to scan with a phone, with the address under it and two
// actions. The address comes from main at each show; nothing here can change what is encoded or copied.
import { h } from '../../pages/shared/dom.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { matrixFor, MAX_QR_CHARACTERS, qrPng, qrSvg } from './qr-svg.js'
import type { QrMatrix } from './qr-svg.js'
import './qr.css'

/** How long a button's label reports what it did before it reads as itself again. */
const FEEDBACK_MS = 2000
const TOO_LONG = 'This address is too long for a QR code.'

const addressOf = (payload: unknown): string => {
  if (typeof payload !== 'object' || payload === null) return ''
  const { url } = payload as Record<string, unknown>
  return typeof url === 'string' ? url : ''
}

export const qrPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    let matrix: QrMatrix | null = null
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

    const tile = h('div', { className: 'qr-tile' })
    const problem = h('p', { className: 'problem', role: 'alert' })
    const address = h('p', { className: 'qr-address' })
    const status = h('p', { className: 'qr-status', role: 'status' })
    status.setAttribute('aria-live', 'polite')
    const download = h('button', { type: 'button', className: 'btn' }, 'Download')
    const copy = h('button', { type: 'button', className: 'btn primary' }, 'Copy link')
    content.append(h('div', { className: 'qr', role: 'dialog', ariaLabel: 'QR code for this page' },
      h('h1', { className: 'sheet-title' }, 'Scan to open this page'),
      h('div', { className: 'sheet-body' }, tile, problem, address),
      status,
      h('div', { className: 'btn-row' }, download, copy)))

    /** Shows `text` on `button` for a moment, then puts its own label back. */
    function report (button: HTMLButtonElement, label: string, text: string): void {
      const pending = timers.get(button)
      if (pending !== undefined) clearTimeout(pending)
      button.textContent = text
      status.textContent = text
      timers.set(button, setTimeout(() => { button.textContent = label; status.textContent = '' }, FEEDBACK_MS))
    }

    copy.addEventListener('click', () => {
      void overlay.request<{ ok?: boolean } | undefined>({ type: 'copy' }).then((reply) => {
        report(copy, 'Copy link', reply?.ok === true ? 'Copied' : 'Could not copy')
      })
    })
    download.addEventListener('click', () => {
      const png = matrix === null ? undefined : qrPng(matrix)
      if (png === undefined) { report(download, 'Download', 'Could not save'); return }
      void overlay.request<{ ok?: boolean } | undefined>({ type: 'download', png }).then((reply) => {
        report(download, 'Download', reply?.ok === true ? 'Saved to Downloads' : 'Could not save')
      })
    })

    return {
      shown (payload) {
        const text = addressOf(payload)
        matrix = matrixFor(text)
        address.textContent = text
        address.title = text
        tile.replaceChildren(...(matrix === null ? [] : [qrSvg(matrix)]))
        tile.hidden = matrix === null
        problem.textContent = matrix === null && text.length > MAX_QR_CHARACTERS ? TOO_LONG : ''
        download.disabled = matrix === null
        copy.focus()
      }
    }
  }
}
