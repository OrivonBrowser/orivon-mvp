import { ipcRenderer } from 'electron'
import { EXTENSION_SW_HEALTH_CHECK_CHANNEL, EXTENSION_SW_HEALTH_REPLY_CHANNEL } from '../main/extensions/extension-sw-preload-recovery.js'

// Called from src/preload/extension-api.ts, right after
// vendor/electron-chrome-extensions/src/preload.ts's own injection code has
// run (or would have -- docs/open-questions.md A289: under --no-sandbox
// this preload script itself never runs for a worker at all, so this
// function never runs either there). Installs a plain `ipcRenderer.on`
// listener, never a fire-and-forget report: main asks
// (extension-sw-preload-recovery.ts, once the worker reaches 'running')
// and this answers, so there is no window where either side's message can
// arrive before the other is listening.
//
// A 'service-worker' session preload also runs in an ordinary website's own
// worker (measured, docs/planning/spike-results/extension-real-probe.json)
// -- gated on the worker's own scope so this listener is never installed
// there, where `chrome` never exists.
export function installServiceWorkerPreloadHealthCheck (): void {
  const workerSelf = globalThis as unknown as { location?: { href?: string } }
  const scope = workerSelf.location?.href ?? ''
  if (!scope.startsWith('chrome-extension://')) return

  ipcRenderer.on(EXTENSION_SW_HEALTH_CHECK_CHANNEL, () => {
    const injectedChrome = (globalThis as { chrome?: { tabs?: { create?: unknown } } }).chrome
    const ok = typeof injectedChrome?.tabs?.create === 'function'
    try {
      ipcRenderer.send(EXTENSION_SW_HEALTH_REPLY_CHANNEL, ok)
    } catch {
      // Best-effort: a worker whose ipc is already gone has bigger problems
      // than this reply failing to send.
    }
  })
}
