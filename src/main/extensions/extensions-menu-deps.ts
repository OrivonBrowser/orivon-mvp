// What the Extensions menu reads and does that lives outside the shell: the
// extension host, the registry and the preferences. Installed once by
// `action-pins-runner.ts`, read by the overlay when a window first opens it,
// so the overlay's module never imports the host (which imports the shell).
import type { WebContents } from 'electron'
import type { ExtensionPrefsStore } from './extension-prefs.js'
import type { ActionInfo, MenuEntry, Rect } from './extensions-menu-model.js'

export interface ExtensionsMenuDeps {
  /** Every enabled extension, with its resolved name and icon. */
  readonly entries: () => Promise<readonly MenuEntry[]>
  readonly isEnabled: (id: string) => boolean
  /** The `chrome-extension:` address of the extension's options page, or undefined when it has none. */
  readonly optionsUrl: (id: string) => string | undefined
  /** Every extension that has an action, pinned or not, as it shows on `tabId`. */
  readonly actions: (tabId: number | undefined) => ReadonlyMap<string, ActionInfo>
  readonly prefs: ExtensionPrefsStore
  /** Runs the action on `tab` as a toolbar click would, its popup under `anchor`. */
  readonly activate: (id: string, tab: WebContents, anchor: Rect) => void
  /** Whether an extension can act on this tab (a tab in the session extensions run in). */
  readonly canActivate: (tab: WebContents) => boolean
  readonly isLoaded: (id: string) => boolean
  readonly uninstall: (id: string) => Promise<void>
}

let installed: ExtensionsMenuDeps | undefined

export function setExtensionsMenuDeps (deps: ExtensionsMenuDeps | undefined): void {
  installed = deps
}

export function extensionsMenuDeps (): ExtensionsMenuDeps | undefined {
  return installed
}
