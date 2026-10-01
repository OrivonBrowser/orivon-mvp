// The one channel every overlay page speaks on, registered on that view's own
// webContents. Identity alone is not enough: the frame must also be at the
// exact address main built, which lock-navigation.ts refuses to ever change,
// so a document that somehow replaced the page still gets no answer.
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { OVERLAY_COMMAND_CHANNEL } from '../channels.js'

/** What the host does for one view; the handler only decodes and checks. */
export interface OverlayPort {
  ready: () => unknown
  request: (command: unknown) => unknown
  size: (height: number) => void
  close: (reason: 'request' | 'escape' | 'blur') => void
}

function isFromOverlay (event: IpcMainInvokeEvent, contents: WebContents, url: string): boolean {
  return event.senderFrame !== null && event.senderFrame === contents.mainFrame && event.senderFrame.url === url
}

/** Registers the handler for `contents`, which was loaded at `url`. */
export function registerOverlayIpc (contents: WebContents, url: string, port: OverlayPort): void {
  contents.ipc.handle(OVERLAY_COMMAND_CHANNEL, async (event: IpcMainInvokeEvent, message: unknown): Promise<unknown> => {
    if (!isFromOverlay(event, contents, url)) return undefined
    if (typeof message !== 'object' || message === null) return undefined
    const { type } = message as { type?: unknown }
    switch (type) {
      case 'ready':
        return await port.ready()
      case 'request':
        // A handler's failure is main's business, not text for the page.
        try {
          return await port.request((message as { command?: unknown }).command)
        } catch (error) {
          console.error('[overlay] a request failed', error)
          return undefined
        }
      case 'size': {
        const { height } = message as { height?: unknown }
        if (typeof height === 'number' && Number.isFinite(height)) port.size(height)
        return undefined
      }
      case 'close':
        {
          const { reason } = message as { reason?: unknown }
          port.close(reason === 'escape' || reason === 'blur' ? reason : 'request')
        }
        return undefined
      default:
        return undefined
    }
  })
}
