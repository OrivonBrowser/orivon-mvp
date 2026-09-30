// Taking the picture: the visible area through the contents' own capture, the whole page through
// the debugger's screenshot command. The debugger is attached for that one command and released in
// every outcome, so a page the person later opens developer tools on is never found already claimed.
import { withTimeout } from './with-timeout.js'

/** Taller than this many device pixels and the capture is cut: larger images fail to encode. */
export const MAX_FULL_PAGE_PIXELS = 16_384

export interface CaptureContents {
  capturePage: () => Promise<{ toPNG: () => Uint8Array, isEmpty: () => boolean }>
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

/** The size to capture, in CSS pixels, cut so the picture is at most `MAX_FULL_PAGE_PIXELS` tall at the page's pixel density. */
export function fullPageClip (content: { width: number, height: number }, density: number): { width: number, height: number, truncated: boolean } {
  const scale = Number.isFinite(density) && density > 0 ? density : 1
  const limit = Math.max(1, Math.floor(MAX_FULL_PAGE_PIXELS / scale))
  const height = Math.max(1, Math.ceil(content.height))
  return { width: Math.max(1, Math.ceil(content.width)), height: Math.min(height, limit), truncated: height > limit }
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

export async function captureFullPage (wc: CaptureContents): Promise<Shot> {
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
    const probe = await send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true })
    const value = isRecord(probe['result']) ? probe['result']['value'] : undefined
    const clip = fullPageClip({ width: size['width'], height: size['height'] }, typeof value === 'number' ? value : 1)
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
