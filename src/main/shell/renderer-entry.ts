// Resolves one of electron-vite's multi-entry renderer outputs to a
// loadable URL, for every view that loads one (window.ts, intro-view.ts,
// permissions/popover-view.ts).

import { shellEntryUrl } from './shell-session.js'
import type { ShellEntry } from './shell-session.js'

/**
 * `raw` is the unvalidated `process.env['ELECTRON_RENDERER_URL']`. A packaged
 * build never honours it: the variable only ever names electron-vite's own
 * dev server (`npm run dev`) or preview run, and a packaged app reading it
 * lets whoever else can set an env var for the launched process -- another
 * OS user squatting a dead dev-server port, on shared hardware -- point the
 * chrome, intro screen or a toolbar popup at a page of their choosing.
 * Loopback-only for the same reason a dev server is loopback-only: nothing
 * legitimate ever names another host. Every caller of `rendererEntryUrl`
 * below passes its `process.env['ELECTRON_RENDERER_URL']` through this
 * first, so the check lives in one place rather than at each call site.
 */
export function validatedDevServerUrl (isPackaged: boolean, raw: string | undefined): string | undefined {
  if (isPackaged || raw === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return undefined
  }
  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  return parsed.protocol === 'http:' && isLoopback ? raw : undefined
}

/**
 * `devServerUrl` is the caller's own `process.env['ELECTRON_RENDERER_URL']`,
 * already passed through `validatedDevServerUrl` above -- electron-vite's dev
 * server serves every renderer entry off the SAME origin at a nested path,
 * one per `rollupOptions.input` key (electron.vite.config.ts). A built shell
 * serves them from the `orivon-shell:` scheme (../pages/shell-scheme.ts), so
 * a page's address never depends on where the app is installed.
 */
export function rendererEntryUrl (devServerUrl: string | undefined, devSubpath: string, entry: ShellEntry): string {
  return devServerUrl !== undefined ? `${devServerUrl}${devSubpath}` : shellEntryUrl(entry)
}
