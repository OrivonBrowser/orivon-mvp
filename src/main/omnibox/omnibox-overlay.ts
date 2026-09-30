// The dropdown under the address bar. The chrome keeps the keys and the focus (the field is where the person
// types), so this overlay never takes focus: main tells it the rows and which is selected, and it answers only
// with the row a mouse chose.
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { isDisposition, pickRow } from './omnibox-actions.js'
import { OMNIBOX_OVERLAY } from './omnibox-names.js'
import { existingOmnibox, omniboxFor } from './omnibox-window.js'

export function createOmniboxOverlay (win: OverlayWindow): OverlayHandler {
  return {
    show: () => omniboxFor(win).snapshot(),
    request: (command) => {
      if (typeof command !== 'object' || command === null) return
      const { type, index, disposition, seq } = command as Record<string, unknown>
      if (type !== 'pick' || typeof index !== 'number' || !Number.isInteger(index) || !isDisposition(disposition)) return
      if (seq !== undefined && (typeof seq !== 'number' || !Number.isInteger(seq))) return
      pickRow(win, index, disposition, seq)
    },
    // Whatever closed it (a tab switch, a resize, a navigation), what it held is stale.
    closed: () => { existingOmnibox(win.window)?.reset() }
  }
}

export const omniboxOverlay: OverlayDef = {
  name: OMNIBOX_OVERLAY,
  placement: { kind: 'anchor-width' },
  surface: 'menu',
  focus: 'never',
  layer: 'popup',
  // Blur is not a reason: the field loses it to this very view when a row is clicked, and the chrome closes on its own blur.
  closeOn: { blur: false, tabSwitch: true, navigation: true, layout: true },
  keep: 'warm',
  height: { initial: 44, min: 44, max: 320 },
  attach: (win) => createOmniboxOverlay(win)
}
