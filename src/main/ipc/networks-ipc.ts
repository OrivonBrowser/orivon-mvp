// The Available networks popup's own command channel: the cards, and a switch. The sender must be the popup's own top
// frame, by identity and by the address it was created at (the popup's view is locked to its document,
// lock-navigation.ts, and its preload gates on the URL). The handler is registered on the popup's own webContents, so it
// goes when the popup does -- see ../networks/networks-panel.ts. While the popup is open, main pushes the cards on every
// change and every two seconds for the figures; nothing is pushed or polled once the popup is gone.

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { NETWORKS_CHANGED_CHANNEL, NETWORKS_COMMAND_CHANNEL } from '../channels.js'
import type { NetworksSource } from '../networks/networks-source.js'
import type { NetworksView } from '../networks/networks-view.js'

export type NetworksCommand =
  | { type: 'view' }
  /** Moves one card's switch. The reply says whether it moved; the new cards follow as a push. */
  | { type: 'setSwitch', id: string, on: boolean }
  /** How tall the rendered cards are, so the popup sizes to them. Advisory: the panel clamps it. */
  | { type: 'contentHeight', height: number }
  /** Escape in the popup's page: closes it. No argument. */
  | { type: 'close' }

/** How often the figures (memory, CPU, bytes) are pushed while the popup is open. */
export const REFRESH_MS = 2_000

/** The least time between two pushes caused by changes: a peer joining or leaving can change a card many times a second, and each push reads the processes' figures. */
export const PUSH_GAP_MS = 300

/** Identity alone is not enough: a `senderFrame` reference can survive a navigation Electron re-points it after, so the committed URL is checked too, as ./ipc.ts's `isFromChrome` does. */
function isFromNetworksPanel (event: IpcMainInvokeEvent, panel: WebContents, panelUrl: string): boolean {
  return event.senderFrame !== null && event.senderFrame === panel.mainFrame && event.senderFrame.url === panelUrl
}

export interface NetworksTimers {
  /** Calls `callback` every `ms` until the returned stop runs. */
  readonly every: (callback: () => void, ms: number) => () => void
  /** Calls `callback` once after `ms` unless the returned stop runs first. */
  readonly after: (callback: () => void, ms: number) => () => void
  readonly now: () => number
}

const REAL_TIMERS: NetworksTimers = {
  every: (callback, ms) => { const timer = setInterval(callback, ms); return () => { clearInterval(timer) } },
  after: (callback, ms) => { const timer = setTimeout(callback, ms); return () => { clearTimeout(timer) } },
  now: Date.now
}

export function registerNetworksIpc (
  panel: WebContents,
  panelUrl: string,
  source: Pick<NetworksSource, 'view' | 'setSwitch' | 'onChange'>,
  onContentHeight: (height: number) => void = () => {},
  closePanel: () => void = () => {},
  timers: NetworksTimers = REAL_TIMERS
): () => void {
  let lastPush = Number.NEGATIVE_INFINITY
  const push = (): void => {
    lastPush = timers.now()
    if (!panel.isDestroyed()) panel.send(NETWORKS_CHANGED_CHANNEL, source.view() satisfies NetworksView)
  }
  // A change pushes at once when the gap since the last push is over, and otherwise once when it is: a burst costs two pushes.
  let waiting: (() => void) | undefined
  const pushSoon = (): void => {
    if (waiting !== undefined) return
    const wait = lastPush + PUSH_GAP_MS - timers.now()
    if (wait <= 0) { push(); return }
    waiting = timers.after(() => { waiting = undefined; push() }, wait)
  }
  const stopListening = source.onChange(pushSoon)
  const stopTimer = timers.every(push, REFRESH_MS)
  // On the popup's own webContents: the handler goes with it, and two windows can each have one open.
  panel.ipc.handle(NETWORKS_COMMAND_CHANNEL, (event: IpcMainInvokeEvent, command: NetworksCommand): void | boolean | NetworksView => {
    if (!isFromNetworksPanel(event, panel, panelUrl)) return
    switch (command.type) {
      case 'view':
        return source.view()
      case 'setSwitch':
        // Typed on the wire, not trusted: the renderer picks the payload.
        return source.setSwitch(command.id, command.on)
      case 'contentHeight':
        // Number.isFinite, not a bare typeof check: NaN and Infinity are both numbers, and either would reach setBounds as a corrupt height.
        if (Number.isFinite(command.height)) onContentHeight(command.height)
        return
      case 'close':
        // After the reply: a non-warm popup's close destroys this webContents, which would drop an invoke still waiting.
        setImmediate(closePanel)
        return
    }
  })
  return () => { stopListening(); stopTimer(); waiting?.(); waiting = undefined }
}
