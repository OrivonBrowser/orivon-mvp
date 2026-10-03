// Whether a webContents is showing a page of an extension: the question a
// quiet manifest apply waits on (effective-manifest-runner.ts).
import { webContents } from 'electron'

/** A page someone can be using: a tab, a popup, an options page. An MV2 extension's background page lives as long as the extension, so waiting for it to close would never end, and the reload brings it back. */
export function extensionPageOpen (extensionId: string): boolean {
  const prefix = `chrome-extension://${extensionId}/`
  return webContents.getAllWebContents().some((contents) =>
    !contents.isDestroyed() && contents.getType() !== 'backgroundPage' && contents.getURL().startsWith(prefix))
}
