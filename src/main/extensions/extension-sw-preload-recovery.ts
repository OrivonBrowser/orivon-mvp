// Detects and, where possible, recovers a worker whose
// session.registerPreloadScript({ type: 'service-worker' }) preload never
// ran -- the extension keeps Electron's own partial
// chrome.tabs/chrome.windows/chrome.action instead of
// electron-chrome-extensions'. docs/open-questions.md A289 has the full
// account. Two distinct causes, both handled by the same one-time reload:
// under `--no-sandbox`, NO 'service-worker'-type session preload ever runs,
// for any worker, reproduced 100%; sandboxed, the preload does run, but a
// freshly loaded extension's first worker still races its registration and
// misses every time (measured: 20/20 cold starts of a fixture extension,
// 4/4 of four real ones) -- recovered every time by the reload below (0
// failures after, same measurements).
//
// The check is MAIN-INITIATED, not worker-announced: the worker's own
// preload (src/preload/extension-sw-verify.ts) installs a plain
// `ipcRenderer.on` listener instead of firing a report on its own, so main
// controls the timing and attaches its own reply listener before asking --
// no window where either side's message can be sent before the other is
// listening. A worker-announced report would depend on the very preload
// injection this check exists to verify: under `--no-sandbox`, where that
// injection never runs at all, the worker's own report would never arrive
// either, for the same root cause.
// This file's own exports reach src/preload/extension-sw-verify.ts, a
// PRELOAD script -- see README.md's Design notes for why this file must
// import nothing beyond `electron`'s ambient types (below).
import type { Session, ServiceWorkerMain } from 'electron'

export const EXTENSION_SW_HEALTH_CHECK_CHANNEL = 'orivon-extension-sw-health-check'
export const EXTENSION_SW_HEALTH_REPLY_CHANNEL = 'orivon-extension-sw-health-reply'

/** How long main waits for a worker's reply before treating it the same as
 * an explicit "not ok" -- a worker that never replies is exactly as
 * unusable to the extension as one that replies false. */
const HEALTH_REPLY_TIMEOUT_MS = 2000

/** `chrome-extension://<32-letter-id>/...` down to `<id>` -- undefined for
 * anything else, so a caller never treats a non-extension worker's scope as
 * an id. Extension ids are always 32 lowercase letters a-p (Electron mints
 * them the same way Chrome does). */
export function extensionIdFromScope (scope: string): string | undefined {
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(scope)
  return match?.[1]
}

export interface PreloadRecoveryDeps {
  readonly getExtensionPath: (id: string) => string | undefined
  readonly removeExtension: (id: string) => void
  readonly loadExtension: (path: string) => Promise<unknown>
  readonly onRecovered?: (id: string) => void
  /** Called immediately before `removeExtension` ('start'), and again, in a
   * `finally`, once `loadExtension` has settled ('end') -- lets a caller
   * tell this remove-then-load apart from a real unload/load pair, so state
   * keyed to a real unload (e.g. extensions-dnr.ts's session rules, badge
   * mode and webRequest registration) is not dropped for an extension that
   * never actually left. Optional so a caller with nothing to protect
   * across the reload (or a test) can leave it out; deliberately generic
   * (this file's own header says why it never names or imports that
   * caller's module itself). */
  readonly onReloadBoundary?: (id: string, phase: 'start' | 'end') => void
}

export interface PreloadRecovery {
  readonly handleUnhealthyWorker: (scope: string) => Promise<void>
}

/** Bounded to one retry per extension id per process lifetime: a second
 * report for the same id is ignored, not retried again, so a genuinely
 * broken extension (or a genuinely broken preload) cannot loop. */
export function createPreloadRecovery (deps: PreloadRecoveryDeps): PreloadRecovery {
  const retried = new Set<string>()
  return {
    async handleUnhealthyWorker (scope: string): Promise<void> {
      const id = extensionIdFromScope(scope)
      if (id === undefined || retried.has(id)) return
      retried.add(id)
      const path = deps.getExtensionPath(id)
      if (path === undefined) return
      deps.onReloadBoundary?.(id, 'start')
      try {
        deps.removeExtension(id)
        await deps.loadExtension(path)
        deps.onRecovered?.(id)
      } finally {
        deps.onReloadBoundary?.(id, 'end')
      }
    }
  }
}

/** Wires createPreloadRecovery to a real session: asks each extension
 * service worker, once it first reaches 'running', whether the library's
 * chrome.tabs actually arrived, and reloads it once if not (or if it never
 * answers). `onReloadBoundary` is forwarded to `createPreloadRecovery`
 * as-is -- extension-host.ts's own call site is what actually supplies
 * extensions-dnr.ts's `beginDnrReload`/`endDnrReload` here, since this file
 * itself must not import that module (its own header says why). */
export function watchForMissedServiceWorkerPreload (
  ses: Session,
  onReloadBoundary?: PreloadRecoveryDeps['onReloadBoundary']
): void {
  const recovery = createPreloadRecovery({
    getExtensionPath: (id) => ses.extensions.getExtension(id)?.path,
    removeExtension: (id) => { ses.extensions.removeExtension(id) },
    // Never allowFileAccess: true -- extensions never get file:// access
    // (README.md's Design notes); every load path in this app agrees.
    loadExtension: async (path) => await ses.extensions.loadExtension(path, { allowFileAccess: false }),
    onRecovered: (id) => {
      console.error(`[extensions] ${id}'s service worker started before the library's preload took effect; reloaded it once to recover`)
    },
    ...(onReloadBoundary === undefined ? {} : { onReloadBoundary })
  })

  const checked = new Set<number>()
  ses.serviceWorkers.on('running-status-changed', (event) => {
    if (event.runningStatus !== 'running' || checked.has(event.versionId)) return
    const worker: ServiceWorkerMain | undefined = ses.serviceWorkers.getWorkerFromVersionID(event.versionId)
    if (worker === undefined || !worker.scope.startsWith('chrome-extension://')) return
    checked.add(event.versionId)

    const scope = worker.scope
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void recovery.handleUnhealthyWorker(scope)
    }, HEALTH_REPLY_TIMEOUT_MS)

    worker.ipc.once(EXTENSION_SW_HEALTH_REPLY_CHANNEL, (_event, ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!ok) void recovery.handleUnhealthyWorker(scope)
    })

    try {
      worker.send(EXTENSION_SW_HEALTH_CHECK_CHANNEL)
    } catch {
      // The worker may already be gone by the time this fires; the timeout
      // above still resolves the wait either way.
    }
  })
}
