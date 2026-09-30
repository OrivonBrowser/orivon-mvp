// What the page tools need from the machine, as one object so a test can hand them a fake. The real
// one is ./real-deps.ts, the only file here that touches the file system, the clipboard or a dialog.
import type { BaseWindow, SaveDialogOptions } from 'electron'

export interface PageToolDeps {
  /** The save dialog: the chosen path, or undefined when the person cancels. */
  pickSave: (window: BaseWindow | undefined, options: SaveDialogOptions) => Promise<string | undefined>
  /** Where a save dialog starts. */
  downloadsDir: () => string
  writeFile: (path: string, data: Uint8Array) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  remove: (path: string) => Promise<void>
  /** The scale factor of the screen a window is on. */
  displayScale: (window: BaseWindow | undefined) => number
  /** Shows a saved file in the system's file manager. */
  reveal: (path: string) => void
  /** Puts a PNG on the clipboard as an image. */
  copyImage: (png: Uint8Array) => Promise<void>
  now: () => Date
  /** Resolves after `ms`; a test makes it instant. */
  wait: (ms: number) => Promise<void>
}
