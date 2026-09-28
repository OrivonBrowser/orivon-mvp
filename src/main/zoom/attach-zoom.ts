// Carries a zoom level out on a page. A tab is set to manual zoom, so the
// browser never zooms on its own and what the person sees is exactly what
// ./zoom-service.ts says: applied when a page commits, when its level changes,
// and when the mouse wheel asks for a step.
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
  // Manual: the mouse wheel then reports a step and leaves the zoom to us.
  contents.setZoomMode('manual')

  const apply = (url: string): void => {
    if (contents.isDestroyed() || !host.isTab(contents)) return
    const factor = zoom.percentFor(originFromUrl(url)) / 100
    if (Math.abs(contents.getZoomFactor() - factor) > 0.001) contents.setZoomFactor(factor)
  }

  // Applied at commit, not once the document is ready, so a page does not paint at the wrong size first.
  contents.on('did-navigate', (_event, url) => { apply(url) })
  const now = host.now ?? (() => performance.now())
  let lastStep: { direction: string, at: number } | null = null
  contents.on('zoom-changed', (_event, direction) => {
    if (!host.isTab(contents)) return
    const at = now()
    if (lastStep?.direction === direction && at - lastStep.at < SAME_TURN_MS) return
    lastStep = { direction, at }
    const origin = originFromUrl(contents.getURL())
    if (origin !== null) zoom.step(origin, direction)
  })
  const stop = zoom.onChange(() => { apply(contents.getURL()) })
  contents.once('destroyed', stop)
}
