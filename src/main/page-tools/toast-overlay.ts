// The toast: one line over the top of the page that says what a page tool did. It never takes focus,
// goes away by itself (later when it offers something to do, and not while the pointer is on it), and is
// replaced, not stacked, by the next one.
import { CLOSE_LIKE_BAR } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { isToastCode, toastAction, toastView, TOAST_ACTION_MS, TOAST_MS } from './toast.js'
import type { ToastCode } from './toast.js'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** `reveal` shows a saved file in its folder. */
export function toastOverlayFor (reveal: (path: string) => void): OverlayDef {
  return {
    name: 'toast',
    placement: { kind: 'area', at: 'top-center', width: 380 },
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
      let revealPath: string | undefined
      let lifetime: number | undefined
      const stop = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
      const start = (): void => {
        stop()
        if (lifetime !== undefined) timer = setTimeout(close, lifetime)
      }
      return {
        show: (payload) => {
          stop()
          if (!isRecord(payload) || !isToastCode(payload['code'])) { close(); return undefined }
          const name = typeof payload['name'] === 'string' ? payload['name'] : undefined
          revealPath = typeof payload['revealPath'] === 'string' ? payload['revealPath'] : undefined
          code = payload['code']
          const view = toastView(code, name, revealPath !== undefined)
          lifetime = view.sticky ? undefined : view.action === undefined ? TOAST_MS : TOAST_ACTION_MS
          start()
          return view
        },
        request: (command) => {
          if (!isRecord(command) || code === undefined) return undefined
          // The pointer is on the toast: it stays until the pointer leaves, then runs its course again.
          if (command['type'] === 'hold') { stop(); return undefined }
          if (command['type'] === 'release') { start(); return undefined }
          if (command['type'] === 'dismiss') { close(); return undefined }
          // The page may only ask for the link the shown toast carries; nothing else it sends does anything.
          if (command['type'] !== 'action') return undefined
          const run = toastAction(code)
          if (run !== undefined) {
            close()
            services.commands.run(run, window)
          } else if (revealPath !== undefined) {
            const path = revealPath
            close()
            reveal(path)
          }
          return undefined
        },
        closed: () => { stop(); code = undefined; revealPath = undefined; lifetime = undefined }
      }
    }
  }
}
