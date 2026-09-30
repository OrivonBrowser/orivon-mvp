// Hooks the recorder into every window: one recorder per set of shell services, made when its first window opens.
import { app } from 'electron'
import type { ShellServices } from '../shell/shell-services.js'
import type { WindowHook } from '../shell/window-hooks.js'
import { SessionRecorder } from './session-recorder.js'

const recorders = new WeakMap<ShellServices, SessionRecorder>()

function recorderFor (services: ShellServices): SessionRecorder {
  let recorder = recorders.get(services)
  if (recorder === undefined) {
    recorder = new SessionRecorder({ session: services.session, closed: services.closedTabs })
    const made = recorder
    // Ahead of the handler that holds the quit while the stores flush: it must find this write waiting.
    app.prependListener('before-quit', () => { made.beforeQuit() })
    recorders.set(services, recorder)
  }
  return recorder
}

export const sessionRecorder: WindowHook = {
  name: 'session-recorder',
  opened: ({ window, services }) => { recorderFor(services).opened(window) },
  closing: ({ window, services }) => { recorderFor(services).closing(window) }
}
