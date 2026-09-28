// Resolves one of electron-vite's multi-entry renderer outputs to a
// loadable URL, for every view that loads one (window.ts, intro-view.ts,
// permissions/popover-view.ts).

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Chromium reports a Windows drive letter in upper case (`file:///C:/`)
 * whatever case the path had, and a preload gate and `isFromChrome` compare
 * this URL with the one Chromium reports character for character. */
export function upperDriveLetter (href: string): string {
  return href.replace(/^file:\/\/\/([a-z]):/, (_match, drive: string) => `file:///${drive.toUpperCase()}:`)
}

/**
 * `devServerUrl` is `process.env['ELECTRON_RENDERER_URL']`, read by the
 * caller -- electron-vite's dev server serves every renderer entry off the
 * SAME origin at a nested path, one per `rollupOptions.input` key
 * (electron.vite.config.ts). `baseDir` is the CALLING module's own
 * `import.meta.dirname`, kept a parameter rather than hardcoded so this
 * file needs no knowledge of where its caller's compiled output lands
 * relative to `../renderer/`.
 */
export function rendererEntryUrl (
  baseDir: string,
  devServerUrl: string | undefined,
  devSubpath: string,
  builtFileRelativePath: string
): string {
  return devServerUrl !== undefined
    ? `${devServerUrl}${devSubpath}`
    : upperDriveLetter(pathToFileURL(join(baseDir, builtFileRelativePath)).href)
}
