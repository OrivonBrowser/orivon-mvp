// The canary of a screen share (ADR-0109): see src/main/display-capture/README.md's Design notes for why the preload makes it.
import { ipcRenderer } from 'electron'
import { DISPLAY_CAPTURE_CHANNEL } from '../main/channels.js'

/**
 * The canary: this world's own `getDisplayMedia` call, which main refuses, queued ahead of the real one. The page cannot
 * reach this world's `MediaDevices`, so it can neither answer for the canary nor change what it asks. Returns false when
 * the call could not be made, in which case the real call is not either. A canary that is served instead of refused
 * means a request was granted that the gate should have refused: its tracks are stopped and main is told, which ends the
 * page's renderer.
 */
export function askCanary (nonce: string): boolean {
  try {
    const devices = navigator.mediaDevices
    void devices.getDisplayMedia({ video: true }).then((served) => {
      for (const track of served.getTracks()) track.stop()
      ipcRenderer.send(DISPLAY_CAPTURE_CHANNEL, { type: 'failed', nonce, name: 'NotAllowedError' })
    }, () => {
      ipcRenderer.send(DISPLAY_CAPTURE_CHANNEL, { type: 'canary', nonce })
    })
    return true
  } catch {
    return false
  }
}
