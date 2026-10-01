// Wires the downloads peek to the process: a started download asks the window's chrome to open it, since
// only the chrome knows where its button is.
import { OVERLAYS } from '../overlays/overlays.js'
import type { ShellServices } from '../shell/shell-services.js'
import { sendChromeEvent } from '../shell/shell-events.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { DOWNLOADS_PEEK_OVERLAY } from './downloads-overlay.js'
import { PEEK_CONTROLLERS, PeekController } from './peek-controller.js'

export const DOWNLOADS_BUTTON_MODULE = 'downloads-button'

export function installDownloadsPeek (services: ShellServices): void {
  const { downloads, settings } = services
  const controller = new PeekController<ShellWindow>({
    showBubble: () => settings.get('downloads.showBubble'),
    buttonAllowed: () => settings.get('toolbar.downloads') !== 'never',
    windowOf: (info) => info.contents === undefined ? undefined : services.windows.findTab(info.contents)?.window,
    popupOpen: (window) => OVERLAYS.some((def) => def.layer === 'popup' && window.overlays.isOpen(def.name)),
    peekOpen: (window) => window.overlays.isOpen(DOWNLOADS_PEEK_OVERLAY),
    requestPeek: (window) => { sendChromeEvent(window, DOWNLOADS_BUTTON_MODULE, { peek: true }) },
    closePeek: (window) => { window.overlays.close(DOWNLOADS_PEEK_OVERLAY) },
    list: () => downloads.list(),
    active: () => downloads.summary().active,
    now: Date.now,
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>) }
  })
  PEEK_CONTROLLERS.set(services, controller as PeekController<object>)
  downloads.onStart((info) => { controller.started(info) })
  downloads.onChange((change) => { controller.changed(change) })
}
