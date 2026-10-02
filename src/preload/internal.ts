import { contextBridge, ipcRenderer } from 'electron'
import { INTERNAL_COMMAND_CHANNEL, INTERNAL_EVENT_CHANNEL } from '../main/channels.js'
import { inMainFrame } from './frame.js'
import { installPageDialogs } from './page-dialogs.js'

// Loaded ONLY by a tab the shell opened as one of its own pages (Settings,
// History, ...; src/main/pages/). The shell names the page in an argument at
// construction, and this exposes nothing unless the document really is that
// page's address: the check is on the scheme and host, not one exact URL,
// since a page is reached at many paths (a deep link, a reload, a reused tab).
//
// One request function and one event subscription, both closures, so the page
// cannot listen on any channel this file did not intend. What a page may ask
// for is decided in main, per call, by src/main/pages/internal-ipc.ts, which
// trusts nothing this file says about the caller.
const PAGE_ARG = '--orivon-internal-page='
const page = process.argv.find((argument) => argument.startsWith(PAGE_ARG))?.slice(PAGE_ARG.length)

installPageDialogs()

if (inMainFrame() && page !== undefined && location.protocol === 'orivon:' && location.hostname === page) {
  contextBridge.exposeInMainWorld('orivonInternal', {
    page,
    request: async (domain: string, command: unknown): Promise<unknown> =>
      await ipcRenderer.invoke(INTERNAL_COMMAND_CHANNEL, { domain, command }),
    /** Returns the unsubscribe. */
    onEvent: (listener: (topic: string, payload: unknown) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: { topic: string, payload: unknown }): void => {
        listener(message.topic, message.payload)
      }
      ipcRenderer.on(INTERNAL_EVENT_CHANNEL, handler)
      return () => { ipcRenderer.removeListener(INTERNAL_EVENT_CHANNEL, handler) }
    },
    platform: process.platform
  })
}
