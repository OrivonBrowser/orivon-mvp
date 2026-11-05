// Where the page's WebGPU question arrives. The top frame's preload (src/preload/webgpu-ask.ts) asks once its
// `requestAdapter()` has an outcome; main reads the message strictly, takes the site from the sender frame's committed
// origin (never from the message) and answers `true` only when the page may keep the adapter it was given.
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { WEBGPU_ASK_CHANNEL } from '../channels.js'
import type { WebGpuAsk } from './webgpu-ask.js'

/** `{ adapter }` and nothing else, or undefined. */
export function readWebGpuAsk (raw: unknown): { adapter: boolean } | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const { adapter } = record
  return Object.keys(record).length === 1 && typeof adapter === 'boolean' ? { adapter } : undefined
}

export interface WebGpuAskIpcDeps {
  ipc: { handle: (channel: string, listener: (event: IpcMainInvokeEvent, raw: unknown) => unknown) => void }
  ask: WebGpuAsk<WebContents>
}

export function registerWebGpuAskIpc (deps: WebGpuAskIpcDeps): void {
  deps.ipc.handle(WEBGPU_ASK_CHANNEL, async (event, raw): Promise<boolean> => {
    const message = readWebGpuAsk(raw)
    const contents = event.sender
    const frame = event.senderFrame
    if (message === undefined || contents.isDestroyed() || frame === null || frame !== contents.mainFrame) return false
    try {
      // The committed origin of the frame that called, which the page cannot set; a frame destroyed under the call throws.
      const origin: unknown = frame.origin
      if (typeof origin !== 'string') return false
      return await deps.ask(contents, origin, message.adapter)
    } catch {
      return false
    }
  })
}
