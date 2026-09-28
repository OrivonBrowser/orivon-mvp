// When a page's developer tools may open, and opening them. Every way in (the
// key, the menu, "Inspect" in a page's own menu) comes through here, so the
// rules hold for all of them: the setting, the shell's own pages, and the one
// question asked before a console can act with an app's permissions.
import type { BaseWindow, WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { SettingsStore } from '../settings/settings-store.js'

export interface DevToolsDeps {
  /** Whether the page at `url` is an app that holds permissions or is installed: its console acts with them. */
  isApp: (url: string) => boolean
  /** One of the shell's own pages (Settings, ...). */
  isShellPage: (contents: WebContents) => boolean
  /** The developer-only overrides are on (set from outside the browser, never from a page). */
  developerMode: () => boolean
  /** Asks whether to go ahead, for an app at `origin`. */
  confirm: (window: BaseWindow, origin: string) => boolean
}

/** What a tab's own menu needs of developer tools. */
export interface DevToolsGate {
  allowed: (contents: WebContents) => boolean
  inspect: (contents: WebContents, window: BaseWindow, x: number, y: number) => void
  /** Closes the tools on `contents`, which is about to stop being the page a tab shows. */
  closeFor: (contents: WebContents) => void
}

export class DevToolsService implements DevToolsGate {
  /** Apps already asked about in this run. */
  private readonly confirmed = new Set<string>()
  private readonly open = new Set<WebContents>()

  constructor (private readonly settings: Pick<SettingsStore, 'get' | 'onChange'>, private readonly deps: DevToolsDeps) {
    // Turning them off takes effect on the tools already open, not only on the next.
    settings.onChange(({ key }) => {
      if (key !== 'developer.tools' || this.settings.get('developer.tools')) return
      for (const contents of [...this.open]) this.closeFor(contents)
    })
  }

  /** Whether the setting, and the kind of page, allow developer tools on `contents`. */
  allowed (contents: WebContents): boolean {
    return this.settings.get('developer.tools') && (this.deps.developerMode() || !this.deps.isShellPage(contents))
  }

  /** Opens them on `contents`, or closes them if they are open. A page with no tab (undefined) does nothing. */
  toggle (contents: WebContents | undefined, window: BaseWindow): void {
    if (contents === undefined || contents.isDestroyed()) return
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools()
      return
    }
    if (this.permit(contents, window)) this.show(contents)
  }

  inspect (contents: WebContents, window: BaseWindow, x: number, y: number): void {
    if (contents.isDestroyed() || !this.permit(contents, window)) return
    if (!contents.isDevToolsOpened()) this.show(contents)
    contents.inspectElement(x, y)
  }

  closeFor (contents: WebContents): void {
    this.open.delete(contents)
    if (!contents.isDestroyed() && contents.isDevToolsOpened()) contents.closeDevTools()
  }

  private permit (contents: WebContents, window: BaseWindow): boolean {
    if (!this.allowed(contents)) return false
    const url = contents.getURL()
    if (!this.deps.isApp(url)) return true
    const origin = originFromUrl(url)
    if (origin === null || this.confirmed.has(origin)) return true
    if (!this.deps.confirm(window, origin)) return false
    this.confirmed.add(origin)
    return true
  }

  private show (contents: WebContents): void {
    contents.openDevTools({ mode: this.settings.get('developer.dock') })
    this.open.add(contents)
    contents.once('devtools-closed', () => { this.open.delete(contents) })
  }
}
