// The screenshot sheet: two choices (what to take, where it goes) over the top of the page. The
// page sends only those two words; the picture is taken after the sheet has closed.
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { activePage } from './active-page.js'
import type { PageToolDeps } from './deps.js'
import { fullPageAvailable } from './screenshot.js'
import { takeScreenshot } from './screenshot-run.js'
import type { ShotArea, ShotTarget } from './screenshot-run.js'

/** What the sheet is told on each show. */
export interface ScreenshotOffer { readonly fullPage: boolean }

/** One frame of the page, so the sheet is gone from the compositor before the capture. */
const CLOSE_SETTLE_MS = 50

function asChoice (command: unknown): { area: ShotArea, to: ShotTarget } | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { area, to, ...rest } = command as Record<string, unknown>
  if (Object.keys(rest).length > 0) return undefined
  if (area !== 'visible' && area !== 'full') return undefined
  if (to !== 'copy' && to !== 'save') return undefined
  return { area, to }
}

export function screenshotOverlayFor (deps: PageToolDeps): OverlayDef {
  return {
    name: 'screenshot',
    placement: { kind: 'area', at: 'top-center', width: 340 },
    surface: 'panel',
    focus: 'take',
    layer: 'popup',
    closeOn: CLOSE_LIKE_POPUP,
    keep: 'fresh',
    height: { initial: 150, min: 120, max: 220 },
    attach: ({ window, close }) => ({
      show: (): ScreenshotOffer => {
        const page = activePage(window)
        return { fullPage: page !== undefined && fullPageAvailable(page.wc) }
      },
      request: (command) => {
        const choice = asChoice(command)
        if (choice === undefined) return undefined
        close()
        void deps.wait(CLOSE_SETTLE_MS).then(async () => {
          const page = activePage(window)
          if (page === undefined) return
          const area = choice.area === 'full' && !fullPageAvailable(page.wc) ? 'visible' : choice.area
          await takeScreenshot(window, page.wc, { ...choice, area }, deps)
        }).catch((error: unknown) => { console.error('[page-tools] the screenshot failed', error) })
        return undefined
      }
    })
  }
}
