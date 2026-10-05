// `ChooseDisplaySource`, the gate's one way to ask the person what to share: it puts the picker in the centre slot
// of the window that holds the asking tab and answers with the choice, or null for every other way out.
import { requestSlot } from '../../overlays/tab-slots.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { ChooseDisplaySource } from '../types.js'
import { PICKER_OVERLAY } from './picker-overlay.js'
import type { PickerStore } from './picker-store.js'

export interface ChooserDeps {
  readonly store: PickerStore
  readonly findTab: (contents: Electron.WebContents) => { window: ShellWindow, tabId: string } | null
}

export function createDisplayChooser ({ store, findTab }: ChooserDeps): ChooseDisplaySource {
  return async (request, signal) => {
    if (signal.aborted) return null
    const found = findTab(request.tab)
    if (found === null) return null
    const { question, answer } = store.add(found.window, found.tabId, request)
    const slot = requestSlot({
      window: found.window,
      tabId: found.tabId,
      slot: 'center',
      overlay: PICKER_OVERLAY,
      payload: { id: question.id },
      // Every way the picker can end but a share (a cancel, Escape, a navigation, a closed tab or window, a full queue) is an answer of no.
      closed: () => { store.settle(question.id, null) }
    })
    const abort = (): void => {
      store.settle(question.id, null)
      slot.cancel()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await answer
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}
