// Taking the picture: the visible area through the contents' own capture, the whole page through
// the debugger's screenshot command. The debugger is attached for that one command and released in
// every outcome, so a page the person later opens developer tools on is never found already claimed.
import { withTimeout } from './with-timeout.js'

/** Taller or wider than this many device pixels and the capture is cut: larger images fail to encode. */
export const MAX_FULL_PAGE_PIXELS = 16_384
/** The most device pixels a full-page picture holds in all: a page that is both tall and wide is cut before the bitmap gets huge. */
export const MAX_FULL_PAGE_AREA = 64_000_000
/** The pixel density is measured on this side, never asked of the page, and kept to what a screen and a zoom can make. */
const MIN_DENSITY = 0.25
const MAX_DENSITY = 8

export interface CaptureContents {
  capturePage: () => Promise<{ toPNG: () => Uint8Array, isEmpty: () => boolean }>
  getZoomFactor: () => number
  isDevToolsOpened: () => boolean
  isCrashed: () => boolean
  readonly debugger: {
    attach: (protocolVersion?: string) => void
    detach: () => void
    isAttached: () => boolean
    sendCommand: (method: string, params?: unknown) => Promise<unknown>
  }
}

export interface Shot {
  readonly png: Uint8Array
  /** The page was taller than the limit and only its top is in the picture. */
  readonly truncated: boolean
}

const CAPTURE_MS = 15_000
const VISIBLE_TRIES = 3
const RETRY_WAIT_MS = 300

/** The debugger is one claim per page: developer tools hold it, so a full-page capture has to wait for them to close. */
export const fullPageAvailable = (wc: Pick<CaptureContents, 'isDevToolsOpened' | 'isCrashed'>): boolean => !wc.isDevToolsOpened() && !wc.isCrashed()

/**
 * The size to capture, in CSS pixels, cut so the picture is at most `MAX_FULL_PAGE_PIXELS` on a side and
 * `MAX_FULL_PAGE_AREA` in all, at the pixel density of the page.
 */
export function fullPageClip (content: { width: number, height: number }, density: number): { width: number, height: number, truncated: boolean } {
  const scale = Number.isFinite(density) && density > 0 ? Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, density)) : 1
  const side = Math.max(1, Math.floor(MAX_FULL_PAGE_PIXELS / scale))
  const wanted = { width: Math.max(1, Math.ceil(content.width)), height: Math.max(1, Math.ceil(content.height)) }
  const width = Math.min(wanted.width, side)
  const tallest = Math.max(1, Math.min(side, Math.floor(MAX_FULL_PAGE_AREA / (width * scale * scale))))
  const height = Math.min(wanted.height, tallest)
  return { width, height, truncated: height < wanted.height || width < wanted.width }
}

/** Device pixels per CSS pixel of the page: the page's zoom on this screen's scale, both known here. */
export function densityOf (wc: Pick<CaptureContents, 'getZoomFactor'>, displayScale: number): number {
  const zoom = wc.getZoomFactor()
  const density = (Number.isFinite(zoom) && zoom > 0 ? zoom : 1) * (Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1)
  return Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, density))
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export async function captureVisible (wc: CaptureContents, wait: (ms: number) => Promise<void>): Promise<Shot> {
  let failure: unknown
  for (let attempt = 0; attempt < VISIBLE_TRIES; attempt++) {
    if (attempt > 0) await wait(RETRY_WAIT_MS)
    try {
      // Right after a navigation the compositor may not have a frame yet; asking again a moment later works.
      const image = await withTimeout(wc.capturePage(), CAPTURE_MS, 'the page')
      if (!image.isEmpty()) return { png: image.toPNG(), truncated: false }
      failure = new Error('the capture was empty')
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/** `displayScale` is the scale factor of the screen the window is on. */
export async function captureFullPage (wc: CaptureContents, displayScale = 1): Promise<Shot> {
  if (!fullPageAvailable(wc)) throw new Error('the page cannot be captured whole while developer tools are open')
  wc.debugger.attach('1.3')
  try {
    const send = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
      const reply = await withTimeout(wc.debugger.sendCommand(method, params), CAPTURE_MS, 'the page')
      return isRecord(reply) ? reply : {}
    }
    const metrics = await send('Page.getLayoutMetrics')
    const size = isRecord(metrics['cssContentSize']) ? metrics['cssContentSize'] : metrics['contentSize']
    if (!isRecord(size) || typeof size['width'] !== 'number' || typeof size['height'] !== 'number') throw new Error('the page reported no size')
    const clip = fullPageClip({ width: size['width'], height: size['height'] }, densityOf(wc, displayScale))
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: clip.width, height: clip.height, scale: 1 }
    })
    if (typeof shot['data'] !== 'string' || shot['data'].length === 0) throw new Error('the capture was empty')
    return { png: Buffer.from(shot['data'], 'base64'), truncated: clip.truncated }
  } finally {
    try { wc.debugger.detach() } catch { /* already detached: the page went away */ }
  }
}
