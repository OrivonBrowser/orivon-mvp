// The chooser sheet: a titled list of rows and one primary button, for any question with a short list of answers.
// The page sends back the id of a row main offered, or a cancel, for the question main named when it showed the sheet.
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { slotClosed } from '../overlays/tab-slots.js'
import { CHOOSER_OVERLAY } from './auth-names.js'
import { choosers } from './chooser-store.js'
import type { ChooserStore, ChooserView } from './chooser-store.js'

const SHEET_WIDTH = 440

type Command = { type: 'choose', id: string, item: string } | { type: 'cancel', id: string }

function asCommand (command: unknown): Command | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, id, item, ...rest } = command as Record<string, unknown>
  if (Object.keys(rest).length > 0 || typeof id !== 'string') return undefined
  if (type === 'cancel' && item === undefined) return { type, id }
  return type === 'choose' && typeof item === 'string' ? { type, id, item } : undefined
}

function asId (payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { id } = payload as { id?: unknown }
  return typeof id === 'string' ? id : undefined
}

export function chooserOverlayFor (store: ChooserStore): OverlayDef {
  return {
    name: CHOOSER_OVERLAY,
    placement: { kind: 'area', at: 'center', width: SHEET_WIDTH },
    surface: 'panel',
    focus: 'take',
    layer: 'bar',
    closeOn: { blur: false, tabSwitch: true, navigation: true, layout: false },
    keep: 'fresh',
    height: { min: 200, max: 460 },
    attach: ({ window, close }: OverlayWindow): OverlayHandler => {
      let shownId: string | null = null
      const current = (id: string): { view: ChooserView } | undefined => {
        const question = store.get(id)
        return question !== undefined && question.owner === window && window.tabs.getState().activeTabId === question.tabId ? question : undefined
      }
      return {
        show: (payload): ChooserView | undefined => {
          const id = asId(payload)
          const question = id === undefined ? undefined : current(id)
          shownId = question === undefined || id === undefined ? null : id
          return question?.view
        },
        request: (command) => {
          const asked = asCommand(command)
          if (asked === undefined || asked.id !== shownId || current(asked.id) === undefined) return undefined
          if (asked.type === 'cancel') {
            store.resolve(asked.id, null)
            close()
          } else if (store.resolve(asked.id, asked.item)) {
            close()
          }
          return undefined
        },
        closed: (reason) => {
          shownId = null
          slotClosed(window, CHOOSER_OVERLAY, reason)
        }
      }
    }
  }
}

export const chooserOverlay = chooserOverlayFor(choosers)
