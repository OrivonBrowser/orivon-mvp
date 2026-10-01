// Whether a webContents is showing a page of an extension: the question a
// quiet manifest apply waits on (effective-manifest-runner.ts).
import { webContents } from 'electron'

export function extensionPageOpen (extensionId: string): boolean {
  const prefix = `chrome-extension://${extensionId}/`
  return webContents.getAllWebContents().some((contents) => !contents.isDestroyed() && contents.getURL().startsWith(prefix))
}
