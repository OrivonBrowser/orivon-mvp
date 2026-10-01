// Carries a zoom level out on a page. A tab has its own zoom (isolated mode), so
// the level is never shared with another tab through the browser's per-site
// memory, and what the person sees is what ./zoom-service.ts says: applied when a
// page commits, when its level changes, and when the mouse wheel asks for a step.
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { ZoomService } from './zoom-service.js'

/** Electron reports one turn of the wheel as two `zoom-changed` events a fraction of a millisecond apart (measured). Two in the same
 * direction closer together than a wheel can turn are one step. */
export const SAME_TURN_MS = 12

export interface ZoomHost {
  /** Whether `contents` is a tab. The chrome, popovers and shell pages are not zoomed. */
  isTab: (contents: WebContents) => boolean
  /** Milliseconds, from any starting point. */
  now?: () => number
}

export function attachZoom (contents: WebContents, zoom: ZoomService, host: ZoomHost): void {
  // Manual until it is known to be a tab: the chrome and the popovers must not zoom, and manual leaves their page pixels alone.
  contents.setZoomMode('manual')
  let isolated = false

  const apply = (url: string): void => {
    if (contents.isDestroyed() || !host.isTab(contents)) return
    // A tab is isolated, not manual: manual keeps the factor Electron reports but does not scale the page. The wheel then also
    // zooms on its own, so `settle` puts the level back to the one ./zoom-service.ts holds.
    if (!isolated) { contents.setZoomMode('isolated'); isolated = true }
    const factor = zoom.percentFor(originFromUrl(url)) / 100
    if (Math.abs(contents.getZoomFactor() - factor) > 0.001) contents.setZoomFactor(factor)
  }

  const settle = (): void => {
    apply(contents.getURL())
    // The wheel's own zoom can land after the event that reports it.
    setTimeout(() => { apply(contents.getURL()) }, 0)
  }

  // Applied at commit, not once the document is ready, so a page does not paint at the wrong size first.
  contents.on('did-navigate', (_event, url) => { apply(url) })
  const now = host.now ?? (() => performance.now())
  let lastStep: { direction: string, at: number } | null = null
  contents.on('zoom-changed', (_event, direction) => {
    if (!host.isTab(contents)) return
    const at = now()
    const sameTurn = lastStep?.direction === direction && at - lastStep.at < SAME_TURN_MS
    if (!sameTurn) {
      lastStep = { direction, at }
      const origin = originFromUrl(contents.getURL())
      if (origin !== null) zoom.step(origin, direction)
    }
    settle()
  })
  const stop = zoom.onChange(() => { apply(contents.getURL()) })
  contents.once('destroyed', stop)
}
