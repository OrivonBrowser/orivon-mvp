// The prompt under the address bar that offers to keep a sign-in. It is Orivon's own HTML; the page never
// sees it. Every command it sends is untrusted input, and the password is handed out only to this prompt,
// to reveal what it is about to save. The chooser that fills the page is in `chooser-overlays.ts`.
import { formsFor } from './forms-registry.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { slotClosed } from '../overlays/tab-slots.js'
import { MAX_USERNAME_LENGTH } from './form-message.js'
import { SAVE_OVERLAY } from './window-forms.js'

/** The prompt closes after this long without the person touching it; the password button still offers the credential. */
export const PROMPT_IDLE_MS = 20_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The prompt: "Save password?" or "Update password?", under the address pill, never taking the keyboard from the page. */
export const passwordSaveOverlay: OverlayDef = {
  name: SAVE_OVERLAY,
  placement: { kind: 'anchor', width: 340, align: 'right' },
  surface: 'panel',
  // The person has just submitted a form and may already be typing in the next page: the prompt asks for the keyboard only when they click it.
  focus: 'never',
  layer: 'bar',
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
  keep: 'fresh',
  height: { initial: 260, min: 40, max: 360 },
  attach: ({ window, services, close, takeFocus }) => {
    const forms = formsFor(window, services)
    let tabId: string | null = null
    let idle: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => { if (idle !== undefined) clearTimeout(idle); idle = undefined }
    const restart = (): void => { stop(); idle = setTimeout(close, PROMPT_IDLE_MS) }
    return {
      show: (payload) => {
        const id = isRecord(payload) && typeof payload['tabId'] === 'string' ? payload['tabId'] : null
        const offer = id === null ? undefined : forms.offerFor(id)
        if (id === null || offer === undefined) { close(); return undefined }
        tabId = id
        restart()
        return offer
      },
      request: async (command) => {
        if (!isRecord(command) || tabId === null) return undefined
        const tab = tabId
        switch (command['type']) {
          case 'save': {
            const username = command['username']
            if (typeof username !== 'string' || username.length > MAX_USERNAME_LENGTH) return undefined
            return { ok: await forms.save(tab, username) }
          }
          case 'never':
            forms.never(tab)
            close()
            return undefined
          case 'dismiss':
            forms.decline(tab)
            close()
            return undefined
          case 'reveal': {
            const password = forms.reveal(tab)
            return password === undefined ? undefined : { password }
          }
          case 'interact':
            restart()
            return undefined
          case 'focus':
            takeFocus?.()
            restart()
            return undefined
          default:
            return undefined
        }
      },
      closed: (reason) => {
        stop()
        tabId = null
        slotClosed(window, SAVE_OVERLAY, reason)
      }
    }
  }
}
