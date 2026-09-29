// What a second launch of this profile does with the addresses it was given
// (index.ts's `opener`). `focused` is `WindowRegistry.focused()`'s result:
// the window the person is using, or undefined when none is open.
import type { ShellWindow } from './window-registry.js'

/** Reuses `focused` for `urls` if one is open; a brand-new window shows itself
 * once ready (`createWithUrls`), rather than being shown here before it can paint. */
export function openUrlsOnSecondLaunch (focused: ShellWindow | undefined, urls: readonly string[], createWithUrls: (urls: readonly string[]) => void): void {
  if (focused === undefined) {
    createWithUrls(urls)
    return
  }
  if (focused.window.isMinimized()) focused.window.restore()
  focused.window.show()
  focused.window.focus()
  for (const url of urls) focused.tabs.createTab(url)
}
