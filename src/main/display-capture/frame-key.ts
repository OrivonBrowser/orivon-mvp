// The ticket key of a tab: its webContents id and its top frame's process and routing ids. Only the top frame of a
// tab can share, so a ticket never needs another frame's key.
import type { WebContents, WebFrameMain } from 'electron'
import { ticketKey } from './display-tickets.js'

/** The key of a frame of `contents`, or undefined once the frame is gone. */
export function frameKeyOf (contents: Pick<WebContents, 'id'>, frame: Pick<WebFrameMain, 'processId' | 'routingId'> | null | undefined): string | undefined {
  return frame === null || frame === undefined ? undefined : ticketKey(contents.id, frame.processId, frame.routingId)
}

/** The key of the tab's top frame, which `mainFrame` throws on once the tab is destroyed. */
export function mainFrameKey (contents: Pick<WebContents, 'id' | 'mainFrame' | 'isDestroyed'>): string | undefined {
  if (contents.isDestroyed()) return undefined
  try {
    return frameKeyOf(contents, contents.mainFrame)
  } catch {
    return undefined
  }
}
