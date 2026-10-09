// The sheet over a tab whose app was not opened: a security warning for files that differ from what the
// site declared (no way forward), or "Couldn't download" with Try again. Main words everything
// (./setup-text.ts); the page sends back the token it was shown with and one fixed word.
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { slotClosed } from '../overlays/tab-slots.js'
import type { SetupSheetView } from './setup-text.js'

export const SETUP_SHEET_OVERLAY = 'app-setup-sheet'

export type SheetChoice = 'retry' | 'leave'

const waiting = new Map<string, (choice: SheetChoice) => void>()

/** Waits for the answer to the sheet shown with `token`; the returned function forgets it. */
export function awaitSheetAnswer (token: string, resolve: (choice: SheetChoice) => void): () => void {
  waiting.set(token, resolve)
  return () => { waiting.delete(token) }
}

/** Delivers an answer to whoever waits for `token`; false when nobody does (a click on a sheet that is gone). */
export function answerSheet (token: string, choice: SheetChoice): boolean {
  const resolve = waiting.get(token)
  if (resolve === undefined) return false
  waiting.delete(token)
  resolve(choice)
  return true
}

const KINDS: ReadonlySet<unknown> = new Set(['blocked', 'download-failed', 'too-large'])

function isView (value: unknown): value is SetupSheetView {
  if (typeof value !== 'object' || value === null) return false
  const view = value as Record<string, unknown>
  return typeof view['token'] === 'string' && KINDS.has(view['kind']) && typeof view['title'] === 'string' && typeof view['body'] === 'string' &&
    Array.isArray(view['files']) && view['files'].every((file) => typeof file === 'string') && typeof view['more'] === 'string' &&
    typeof view['address'] === 'string' && typeof view['note'] === 'string' && typeof view['canRetry'] === 'boolean'
}

function asCommand (command: unknown): { type: SheetChoice, token: string } | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, token } = command as { type?: unknown, token?: unknown }
  if (Object.keys(command).length !== 2 || typeof token !== 'string') return undefined
  return type === 'retry' || type === 'leave' ? { type, token } : undefined
}

export const setupSheetOverlay: OverlayDef = {
  name: SETUP_SHEET_OVERLAY,
  placement: { kind: 'area', at: 'center', width: 460 },
  surface: 'panel',
  focus: 'take',
  layer: 'bar',
  // The address in the bar is the app that was not opened, so it changing is not the person leaving: the
  // tab's screens take the sheet away when the tab starts a navigation of its own.
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
  keep: 'fresh',
  height: { min: 220, max: 420 },
  attach: ({ window }: OverlayWindow): OverlayHandler => {
    let shown: SetupSheetView | undefined
    return {
      show: (payload): SetupSheetView | undefined => {
        shown = isView(payload) ? payload : undefined
        return shown
      },
      request: (command) => {
        const asked = asCommand(command)
        const view = shown
        if (asked === undefined || view === undefined || asked.token !== view.token) return undefined
        if (asked.type === 'retry' && !view.canRetry) return undefined
        answerSheet(asked.token, asked.type)
        return undefined
      },
      closed: (reason) => {
        shown = undefined
        slotClosed(window, SETUP_SHEET_OVERLAY, reason)
      }
    }
  }
}
