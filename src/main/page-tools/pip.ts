// Picture in picture: pop the page's main video out, or put it back. The scripts are constants; no
// page text reaches them. Run with a user gesture, because the browser refuses the request without one.
import { withTimeout } from './with-timeout.js'

/** Puts back a video that is already out, in the document that holds it. Answers whether it did. */
export const EXIT_SCRIPT = `(async () => {
  if (!document.pictureInPictureElement) return false
  await document.exitPictureInPicture()
  return true
})()`

/** Pops out the video playing now, else the largest one on screen. Answers whether it did. */
export const ENTER_SCRIPT = `(async () => {
  const seen = (v) => {
    const r = v.getBoundingClientRect()
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0))
    return w * h
  }
  const usable = [...document.querySelectorAll('video')].filter((v) => !v.disablePictureInPicture && v.readyState > 0 && seen(v) > 0)
  const playing = usable.filter((v) => !v.paused && !v.ended)
  const pool = playing.length > 0 ? playing : usable
  pool.sort((a, b) => seen(b) - seen(a))
  if (pool.length === 0) return false
  await pool[0].requestPictureInPicture()
  return true
})()`

export interface PipFrame { executeJavaScript: (code: string, userGesture: boolean) => Promise<unknown> }
export interface PipContents {
  readonly mainFrame: { readonly framesInSubtree: readonly PipFrame[] }
  isCrashed: () => boolean
}

export type PipOutcome = 'entered' | 'exited' | 'none'

const PIP_MS = 4000

/** The first frame that answers true wins; a frame that throws (no video it may use, a frame with no permission) is skipped. */
async function firstFrameToAnswer (frames: readonly PipFrame[], script: string): Promise<boolean> {
  for (const frame of frames) {
    try {
      if (await withTimeout(frame.executeJavaScript(script, true), PIP_MS, 'the frame') === true) return true
    } catch {
      continue
    }
  }
  return false
}

export async function togglePictureInPicture (wc: PipContents): Promise<PipOutcome> {
  if (wc.isCrashed()) return 'none'
  const frames = wc.mainFrame.framesInSubtree
  // Every frame is asked to put a video back before any is asked to pop one out: a video out in an embedded frame must not be joined by a second.
  if (await firstFrameToAnswer(frames, EXIT_SCRIPT)) return 'exited'
  return await firstFrameToAnswer(frames, ENTER_SCRIPT) ? 'entered' : 'none'
}
