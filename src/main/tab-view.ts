// How one tab's WebContentsView is constructed and which Electron session
// partition it gets -- split out of tabs.ts (see that directory's README,
// `## Design notes`, for why). Pure with respect to TabManager: neither
// function here reads or writes any tab-collection state.
import { WebContentsView } from 'electron'
import { partitionFor } from '../broker/grants/origin-hash.js'
import { originFromUrl } from '../broker/policy/origin.js'

/** `partitionFor`/`originFromUrl` are the SAME functions the broker uses to
 * key its grant ledger and (ADR-0007) to register a cached bundle's own
 * protocol interception -- so a tab and its eventual grant always agree on
 * which Electron session an origin means. Returns undefined for anything
 * with no derivable origin (about:blank, a rejected navigation), which
 * keeps that tab on the shell's own default session -- there is no app
 * storage to isolate for a page the user never reached. */
export function partitionForTarget (target: string): string | undefined {
  const origin = originFromUrl(target)
  return origin === null ? undefined : partitionFor(origin)
}

/** Builds one tab's WebContentsView with the standard, non-negotiable
 * webPreferences (contextIsolation/sandbox/no Node integration/
 * webSecurity), shared by tabs.ts's createTab() and repartitionView() so
 * the two can never drift apart on these (Rule 3). */
export function makeTabView (preload: string, partition: string | undefined, additionalArguments?: string[]): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      preload,
      ...(additionalArguments !== undefined ? { additionalArguments } : {}),
      ...(partition !== undefined ? { partition } : {}),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
}
