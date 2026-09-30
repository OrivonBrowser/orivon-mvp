// The line at the foot of the page that says what just happened and, for a delete, offers to take it back. One at a
// time; a new one replaces the last. It is a live region, so a screen reader hears it without the focus moving.
import { h } from '../shared/dom.js'

export const TOAST_MS = 6_000

export interface ToastAction {
  readonly label: string
  readonly run: () => void
}

let timer: ReturnType<typeof setTimeout> | undefined
const region = h('div', { className: 'toast-region', role: 'status' })
region.setAttribute('aria-live', 'polite')

export const toastRegion = region

export function hideToast (): void {
  clearTimeout(timer)
  region.replaceChildren()
}

export function showToast (text: string, action?: ToastAction): void {
  clearTimeout(timer)
  const toast = h('div', { className: 'toast' }, h('span', { textContent: text }))
  if (action !== undefined) {
    toast.append(h('button', { className: 'link-btn', type: 'button', textContent: action.label, onclick: () => { hideToast(); action.run() } }))
  }
  region.replaceChildren(toast)
  timer = setTimeout(hideToast, TOAST_MS)
}

/** The action of the toast on screen, for the undo key; null when there is none. */
export function pendingToastAction (): HTMLButtonElement | null {
  return region.querySelector<HTMLButtonElement>('.link-btn')
}
