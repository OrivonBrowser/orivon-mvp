// What a second launch of this profile does with the addresses it was given
// (index.ts's `opener`). `focused` is `WindowRegistry.focused()`'s result:
// the window the person is using, or undefined when none is open.
import type { ShellWindow } from './window-registry.js'
import type { ShellWindowOptions } from './window-options.js'

/** Reuses `focused` for `urls` if one is open. Otherwise `create` opens a window,
 * which shows itself once ready rather than being shown here before it can paint:
 * the urls take the place of its new-tab page, which it keeps when there are none. */
export function openUrlsOnSecondLaunch (focused: ShellWindow | undefined, urls: readonly string[], create: (options: ShellWindowOptions) => void): void {
  if (focused === undefined) {
    create(urls.length === 0 ? {} : { first: (tabs) => { for (const url of urls) tabs.createTab(url) } })
    return
  }
  if (focused.window.isMinimized()) focused.window.restore()
  focused.window.show()
  focused.window.focus()
  for (const url of urls) focused.tabs.createTab(url)
}
