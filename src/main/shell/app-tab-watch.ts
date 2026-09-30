// A registered app's tab reports its own failures: an uncaught error, a preload
// that never ran, a dead renderer. Split out of tab-view.ts.
import type { WebContentsView } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { APP_TAB_FLAG, appTabOrigins, appTabViews } from './tab-partition.js'

/** A registered app's tab gets its failures reported; see reportAppFailures. */
export function watchAppTab (view: WebContentsView, additionalArguments: string[] | undefined, target?: string): void {
  if (additionalArguments?.includes(APP_TAB_FLAG) !== true) return
  appTabViews.add(view)
  const origin = target !== undefined ? originFromUrl(target) : null
  if (origin !== null) appTabOrigins.set(view, origin)
  reportAppFailures(view)
}

/** Prints what an app's own page cannot tell anyone: an uncaught error, a
 * preload that never ran, a dead renderer. An app whose bundle throws while
 * its module graph is still evaluating renders nothing and logs nothing the
 * shell can see, so the first symptom is a blank window with no cause --
 * which is what makes that class of bug expensive rather than hard.
 *
 * REGISTERED APP TABS ONLY, which is why this hangs off the app-tab flag
 * rather than every view: the open web logs errors constantly, and a browser
 * that narrated them all would bury the one case anybody is debugging.
 *
 * Attached per view, not once via `app.on('session-created')` the way
 * `./permission-gate.ts` is. That is not an inconsistency: a session both
 * precedes and outlives the views on it, so a session-scoped handler must be
 * installed where sessions are made. These three events are webContents-
 * scoped and fire on one view's own contents, which is exactly what this
 * function is handed. */
function reportAppFailures (view: WebContentsView): void {
  const { webContents } = view
  const where = (): string => webContents.isDestroyed() ? '(closed)' : webContents.getURL()

  webContents.on('console-message', (details) => {
    if (details.level !== 'error') return
    // An inline or generated script has no sourceId, and `(:1)` reads as a
    // broken path rather than an absent one -- say nothing instead.
    const at = details.sourceId === '' ? '' : `  (${details.sourceId}:${String(details.lineNumber)})`
    console.error(`[orivon][app ${where()}] ${details.message}${at}`)
  })
  webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[orivon][app ${where()}] its preload threw, so no capability surface exists on the page (${preloadPath})`, error)
  })
  webContents.on('render-process-gone', (_event, details) => {
    console.error(`[orivon][app ${where()}] the renderer died: ${details.reason} (exit ${String(details.exitCode)})`)
  })
}
