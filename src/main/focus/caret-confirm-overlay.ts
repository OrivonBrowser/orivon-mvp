// The sheet F7 shows before it turns caret browsing on. The page can answer only "turn it on" (with whether to stop
// asking) or "cancel"; what the setting becomes is decided here.
import { CARET_ASK_SETTING, CARET_CONFIRM_OVERLAY } from './caret.js'
import { setCaret } from './caret-runner.js'
import { slotClosed } from '../overlays/tab-slots.js'
import type { OverlayDef } from '../overlays/overlay-types.js'

export const caretConfirmOverlay: OverlayDef = {
  name: CARET_CONFIRM_OVERLAY,
  placement: { kind: 'area', at: 'center', width: 420 },
  surface: 'panel',
  focus: 'take',
  layer: 'bar',
  // Only leaving its tab dismisses it: a page navigating or the window resizing leaves it be.
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
  keep: 'fresh',
  height: { initial: 220, min: 200, max: 320 },
  attach: (win) => ({
    // The key that turns it off again, as it is bound now: the sheet names it.
    show: () => ({ keys: win.services.shortcuts.rows().find((row) => row.id === 'caret.toggle')?.keys ?? null }),
    request: (command) => {
      if (typeof command !== 'object' || command === null) return undefined
      const { type, dontAsk } = command as { type?: unknown, dontAsk?: unknown }
      if (type === 'cancel') {
        win.close()
      } else if (type === 'confirm' && typeof dontAsk === 'boolean') {
        if (dontAsk) win.services.settings.set(CARET_ASK_SETTING, false)
        win.close()
        setCaret(win, true)
      }
      return undefined
    },
    closed: (reason) => { slotClosed(win.window, CARET_CONFIRM_OVERLAY, reason) }
  })
}
