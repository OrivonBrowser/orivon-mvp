// Asks the person to pick one of a short list, in a sheet over the tab that caused the question. Resolves with
// the id of the chosen row, or null when the sheet was cancelled, dismissed or never shown.
import { requestSlot } from '../overlays/tab-slots.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { CHOOSER_OVERLAY } from './auth-names.js'
import { choosers } from './chooser-store.js'
import type { ChooserSpec } from './chooser-store.js'

export type { ChooserItem, ChooserSpec } from './chooser-store.js'

export async function askChooser (window: ShellWindow, tabId: string, spec: ChooserSpec): Promise<string | null> {
  const { id, answer } = choosers.add(window, tabId, spec)
  requestSlot({
    window,
    tabId,
    slot: 'center',
    overlay: CHOOSER_OVERLAY,
    payload: { id },
    // Every way the sheet can end but a choice leaves the question unanswered, and it is answered no.
    closed: () => { choosers.resolve(id, null) }
  })
  return await answer
}
