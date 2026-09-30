// The toast: one line over the top of the page that says what a page tool did. It never takes focus,
// goes away by itself, and is replaced, not stacked, by the next one.
import { CLOSE_LIKE_BAR } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { isToastCode, toastAction, toastView, TOAST_MS } from './toast.js'
import type { ToastCode } from './toast.js'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const toastOverlay: OverlayDef = {
  name: 'toast',
  placement: { kind: 'area', at: 'top-center', width: 320 },
  surface: 'panel',
  focus: 'never',
  layer: 'bar',
  // It stays over the tab it was made for only until the person goes elsewhere.
  closeOn: CLOSE_LIKE_BAR,
  keep: 'warm',
  height: { initial: 40, min: 40, max: 40 },
  attach: ({ window, services, close }) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let code: ToastCode | undefined
    const stop = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
    return {
      show: (payload) => {
        stop()
        if (!isRecord(payload) || !isToastCode(payload['code'])) { close(); return undefined }
        const name = typeof payload['name'] === 'string' ? payload['name'] : undefined
        code = payload['code']
        const view = toastView(code, name)
        if (!view.sticky) timer = setTimeout(close, TOAST_MS)
        return view
      },
      // The page may only ask for the link the shown toast carries; nothing else it sends does anything.
      request: (command) => {
        if (!isRecord(command) || command['type'] !== 'action' || code === undefined) return undefined
        const run = toastAction(code)
        if (run === undefined) return undefined
        close()
        services.commands.run(run, window)
        return undefined
      },
      closed: () => { stop(); code = undefined }
    }
  }
}
