// The bar that offers the last session back after a crash: one row at the top of the tab area that never takes
// focus and goes away by itself. It carries no data, so the page can ask for two things and nothing else.
import type { OverlayDef } from '../overlays/overlay-types.js'
import { restoreWindows, takeOffStack } from './startup-open.js'
import type { Displays } from './startup-open.js'
import { usableWindows } from './startup-plan.js'

export const RESTORE_OVERLAY = 'restore'
export const OFFER_SHOWN_MS = 30_000
const BAR_WIDTH = 420
const BAR_HEIGHT = 44

export interface RestoreDeps {
  readonly displays: () => Displays
}

export function restoreOverlayFor (deps: RestoreDeps): OverlayDef {
  return {
    name: RESTORE_OVERLAY,
    placement: { kind: 'area', at: 'top-center', width: BAR_WIDTH },
    surface: 'panel',
    focus: 'never',
    layer: 'bar',
    // It is about the launch, not about a tab: switching tabs or pages leaves it until it is answered or times out.
    closeOn: { blur: false, tabSwitch: false, navigation: false, layout: false },
    keep: 'fresh',
    height: { initial: BAR_HEIGHT, min: BAR_HEIGHT, max: BAR_HEIGHT },
    attach: ({ services, close }) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let restored = false
      const stop = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
      return {
        show: () => {
          stop()
          timer = setTimeout(close, OFFER_SHOWN_MS)
          timer.unref()
          return undefined
        },
        request: (command) => {
          const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
          if (type === 'dismiss') { close(); return undefined }
          if (type !== 'restore' || restored) return undefined
          restored = true
          close()
          const windows = usableWindows(services.session.previous())
          takeOffStack(services.closedTabs, windows)
          restoreWindows(windows, (options) => { services.commands.openWindow(options) }, deps.displays())
          return undefined
        },
        closed: stop
      }
    }
  }
}
