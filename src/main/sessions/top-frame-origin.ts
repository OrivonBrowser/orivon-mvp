// Who a page's own message to main speaks for: the top frame's committed origin. The preloads that ask main about the
// page they run in (`permission-query-ipc.ts`, `../site-settings/webgpu-ask-ipc.ts`) take the site from here and never
// from the message, which the page writes.
import type { IpcMainInvokeEvent } from 'electron'

/**
 * The committed origin of the top frame that sent `event`, which the page cannot set; undefined for a destroyed sender,
 * a frame that is not its top frame, and a frame destroyed under the call (reading it throws).
 */
export function topFrameOrigin (event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): string | undefined {
  const contents = event.sender
  const frame = event.senderFrame
  if (contents.isDestroyed() || frame === null || frame !== contents.mainFrame) return undefined
  try {
    const origin: unknown = frame.origin
    return typeof origin === 'string' ? origin : undefined
  } catch {
    return undefined
  }
}
