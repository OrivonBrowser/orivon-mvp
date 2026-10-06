// The sharing bar: who is sharing what, with Stop sharing and Hide. It never takes focus (main keeps the keys), so it
// is driven by the mouse; the text is a status, announced when it changes. Main sends the sentence, the page draws it.
import type { SharingBarView } from '../../../main/display-capture/indicators/sharing-bar.js'
import { h } from '../../pages/shared/dom.js'
import { closeIcon } from '../../pages/shared/icons.js'
import { SITE_KIND_ICONS } from '../../pages/shared/site-kind-icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import './sharing-bar.css'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export function isSharingBarView (value: unknown): value is SharingBarView {
  return isRecord(value) && typeof value['text'] === 'string' && typeof value['count'] === 'number'
}

export const sharingBarPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const text = h('span', { className: 'sharing-text', role: 'status' })
    const stop = h('button', { type: 'button', className: 'btn small danger', textContent: 'Stop sharing', onclick: () => { void overlay.request({ type: 'stop' }) } })
    const hide = h('button', { type: 'button', className: 'btn icon', ariaLabel: 'Hide this bar', title: 'Hide', onclick: () => { void overlay.request({ type: 'hide' }) } }, closeIcon())
    content.append(h('div', { className: 'sharingbar' }, h('span', { className: 'sharing-mark' }, SITE_KIND_ICONS.screenShare()), text, stop, hide))
    const draw = (view: unknown): void => {
      if (!isSharingBarView(view)) { overlay.close(); return }
      text.textContent = view.text
    }
    overlay.onEvent((event) => { if (isRecord(event) && event['type'] === 'view') draw(event['view']) })
    return { shown: draw }
  }
}
