import { contextBridge, ipcRenderer } from 'electron'
import { SPLIT_FRAME_CHANNEL, SPLIT_STATE_CHANNEL } from '../main/channels.js'
import type { FrameState } from '../main/shell/split-controller.js'

// Loaded ONLY by the split backdrop's own view (src/main/shell/split-frame.ts).
// Same defence as the popovers' preloads: nothing is exposed unless the document
// is at the address main gave it. What it can ask is to drag the divider to a
// place, or put it back to half; src/main/shell/split-frame.ts hears only this
// view's top frame and checks the number.
const URL_PREFIX = '--orivon-split-frame-url='
const expectedUrl = process.argv.find((arg) => arg.startsWith(URL_PREFIX))?.slice(URL_PREFIX.length)

if (expectedUrl !== undefined && location.href === expectedUrl) {
  contextBridge.exposeInMainWorld('orivonSplit', {
    /** Returns the unsubscribe. */
    onState: (listener: (state: FrameState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: FrameState): void => { listener(state) }
      ipcRenderer.on(SPLIT_STATE_CHANNEL, handler)
      return () => { ipcRenderer.removeListener(SPLIT_STATE_CHANNEL, handler) }
    },
    drag: (at: number): void => { void ipcRenderer.invoke(SPLIT_FRAME_CHANNEL, { type: 'drag', at }) },
    reset: (): void => { void ipcRenderer.invoke(SPLIT_FRAME_CHANNEL, { type: 'reset' }) }
  })
}
