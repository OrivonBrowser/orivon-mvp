// The picker wired to the real displays and the real tabs, for the registry in ../../overlays/overlays.ts.
import { desktopCapturer, shell } from 'electron'
import { imageToDataUrl } from '../../shell/tear-drag.js'
import { captureTabPage } from '../../shell/tab-view.js'
import { detectPlatform } from './picker-platform.js'
import { pickerOverlayFor, THUMB_SIZE } from './picker-overlay.js'
import { THUMB_QUALITY } from './picker-sources.js'
import { PickerStore } from './picker-store.js'
import type { RawSource } from './picker-sources.js'

/** The questions the picker is asking, for the overlay and for the chooser that adds them. */
export const pickerStore = new PickerStore()

/** A page behind the one in front may never answer a capture: the wait is bounded. */
const CAPTURE_WAIT_MS = 400

export const screenSharePickerOverlay = pickerOverlayFor({
  store: pickerStore,
  platform: () => detectPlatform(),
  getSources: async (listing) => await desktopCapturer.getSources({ ...listing }) as readonly RawSource[],
  captureTab: async (tab) => {
    const image = await Promise.race([captureTabPage(tab), new Promise<null>((resolve) => { setTimeout(resolve, CAPTURE_WAIT_MS, null) })])
    return imageToDataUrl(image, THUMB_SIZE, THUMB_QUALITY)
  },
  openSettings: (url) => { void shell.openExternal(url) }
})
