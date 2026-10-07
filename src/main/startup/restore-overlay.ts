// The bar that offers the last session back after a crash, and the report of it: one row at the top of the tab area
// that never takes focus and goes away by itself. The page can ask for three things and nothing else.
import type { OverlayDef } from '../overlays/overlay-types.js'
import { restoreWindows, takeOffStack } from './startup-open.js'
import { deferUntilFuseKnown, holdsLocalFile } from '../session-restore/fuse-wait.js'
import type { Displays } from '../session-restore/restore.js'
import { usableWindows } from './startup-plan.js'
import { lastRunCrashId, reportPath } from '../diagnostics/crash-lookup.js'

export const RESTORE_OVERLAY = 'restore'
export const OFFER_SHOWN_MS = 30_000
const BAR_WIDTH = 540
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
    attach: ({ window, services, close }) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let restored = false
      const stop = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
      return {
        show: (payload) => {
          stop()
          timer = setTimeout(close, OFFER_SHOWN_MS)
          timer.unref()
          const asked = (typeof payload === 'object' && payload !== null ? payload : {}) as { restore?: unknown, report?: unknown }
          // The offer to restore is the bar's reason by default; the report is only there when the last run left a crash to report.
          return { keys: services.shortcuts.keysOf('tab.reopen'), restore: asked.restore !== false, report: asked.report === true }
        },
        request: (command) => {
          const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
          if (type === 'dismiss') { close(); return undefined }
          if (type === 'report') {
            close()
            window.tabs.openInternal('report', reportPath(lastRunCrashId()))
            return undefined
          }
          if (type !== 'restore' || restored) return undefined
          restored = true
          close()
          // Only what Reopen has not already brought back: a second copy of a window is worse than none.
          const windows = takeOffStack(services.closedTabs, usableWindows(services.session.previous()))
          const open = (): void => { restoreWindows(windows, (options) => { services.commands.openWindow(options) }, deps.displays()) }
          if (!deferUntilFuseKnown(windows.some((window) => holdsLocalFile(window.tabs)), open)) open()
          return undefined
        },
        closed: stop
      }
    }
  }
}
