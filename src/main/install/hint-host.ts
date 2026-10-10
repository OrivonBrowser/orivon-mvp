// A first visit that began from a page's own manifest hint (ADR-0076): the way into a tab no window holds, which has no
// screens to draw. A tab a window holds uses `../app-setup/tab-host.ts`, as a visit that began at its request does.
import type { SetupHost } from './first-visit.js'

/**
 * A hint from contents no window holds as a tab: nothing can be drawn over them, so a question is the only screen and
 * a failure is only logged. The page keeps running as the ordinary website it is; entering reloads it, and the tab
 * becomes the app on that reload. The order is the same: ask, then grant and enter, then check the bundle.
 */
export function headlessHost (sender: { reload: () => void, isDestroyed: () => boolean }): SetupHost {
  return {
    sheet: async () => 'leave',
    enter: () => { if (!sender.isDestroyed()) sender.reload() },
    plain: () => {},
    end: () => {}
  }
}
