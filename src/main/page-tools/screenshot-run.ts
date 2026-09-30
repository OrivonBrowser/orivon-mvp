// Taking a screenshot and putting it where the person chose: the clipboard or a PNG file.
import { join } from 'node:path'
import type { ShellWindow } from '../shell/window-registry.js'
import type { PageToolDeps } from './deps.js'
import { baseName, screenshotName } from './file-names.js'
import { captureFullPage, captureVisible } from './screenshot.js'
import type { CaptureContents } from './screenshot.js'
import { showToast } from './toast.js'
import { withTimeout } from './with-timeout.js'

export type ShotArea = 'visible' | 'full'
export type ShotTarget = 'copy' | 'save'

/** The clipboard may never answer on a machine with no display server to hold it. */
const COPY_MS = 2000

export async function takeScreenshot (window: ShellWindow, wc: CaptureContents, choice: { area: ShotArea, to: ShotTarget }, deps: PageToolDeps): Promise<void> {
  let shot: Awaited<ReturnType<typeof captureVisible>>
  try {
    shot = choice.area === 'full' ? await captureFullPage(wc) : await captureVisible(wc, deps.wait)
  } catch (error) {
    console.error('[page-tools] the screenshot failed', error)
    showToast(window, 'shotFailed')
    return
  }
  if (choice.to === 'copy') {
    try {
      await withTimeout(deps.copyImage(shot.png), COPY_MS, 'the clipboard')
      showToast(window, 'copied')
    } catch (error) {
      console.error('[page-tools] copying the screenshot failed', error)
      showToast(window, 'copyFailed')
    }
    return
  }
  const path = await deps.pickSave(window.window, {
    title: 'Save screenshot',
    defaultPath: join(deps.downloadsDir(), screenshotName(deps.now())),
    filters: [{ name: 'PNG image', extensions: ['png'] }]
  })
  if (path === undefined) return
  try {
    await deps.writeFile(path, shot.png)
    if (shot.truncated) showToast(window, 'longPage')
    else showToast(window, 'saved', baseName(path))
  } catch (error) {
    console.error('[page-tools] writing the screenshot failed', error)
    showToast(window, 'shotFailed')
  }
}
