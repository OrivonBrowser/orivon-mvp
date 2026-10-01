// What an extension API module sees: the narrow set of things it may call.
// A module gets no `electron` handle, router or session of its own; every
// reach into the shell, the extension host or the router goes through here,
// so a lane adding `chrome.<ns>` writes one file and never edits the host.
import type { ServiceWorkerMain, Session, WebContents } from 'electron'
import type { ElectronChromeExtensions } from 'orivon:crx-extensions'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { ExtensionsApi } from '../extensions-subsystem.js'
import type { ExtensionPrefsStore } from '../extension-prefs.js'

/** The caller of a handler, already identified: the router has checked that
 * the sender's own `chrome-extension://` frame or worker belongs to
 * `extension` (`senderMatchesClaimedExtensionId`), so a web page, a content
 * script or another extension never gets this far. */
export interface ApiEvent {
  readonly type: 'frame' | 'service-worker'
  readonly sender: WebContents | ServiceWorkerMain | undefined
  readonly extension: { readonly id: string, readonly manifest: Record<string, unknown> }
}

/** A tab as the shell holds it: the library's tab id is `contents.id`. */
export interface ResolvedTab {
  readonly contents: WebContents
  readonly window: ShellWindow
  readonly id: string
}

export interface ExtensionApiContext {
  /** Registers `chrome.<name>`'s handler; `opts.permission` overrides the module's default one. */
  readonly handle: (name: string, run: (event: ApiEvent, ...args: unknown[]) => unknown, opts?: { permission?: string | undefined }) => void
  /** Sends an event to one extension's listeners (every extension's when undefined). */
  readonly sendEvent: (extensionId: string | undefined, name: string, ...args: unknown[]) => void
  readonly host: ElectronChromeExtensions
  readonly session: Session
  readonly userDataPath: string
  /** Undefined until the first window exists. */
  readonly shell: () => ShellServices | undefined
  readonly extensions: () => ExtensionsApi | undefined
  readonly prefs: ExtensionPrefsStore
  readonly held: (extensionId: string, permission: string) => boolean
  readonly tab: (tabId: unknown) => ResolvedTab | undefined
  readonly activeTab: (windowId?: unknown) => ResolvedTab | undefined
  /** The extension's host access covers the tab's current URL. */
  readonly canSee: (extensionId: string, contents: WebContents) => boolean
  /** The URL belongs to a registered app's origin: every data API keeps such
   * URLs, tabs and storage out of its answers and events. */
  readonly isAppOrigin: (url: string) => boolean
}

export interface ExtensionApiModule {
  /** The namespace: `chrome.<name>`, and the prefix of its events. */
  readonly name: string
  /** Default permission of every handler and event of this namespace. */
  readonly permission?: string
  readonly install: (ctx: ExtensionApiContext) => void
}
