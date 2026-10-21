// When a page's developer tools may open, and opening them. Every way in (the
// key, the menu, "Inspect" in a page's own menu) comes through here, so the
// rules hold for all of them: the setting, the shell's own pages, and the one
// question asked before a console can act with an app's permissions.
import type { WebContents } from 'electron'
import type { SettingsStore } from '../settings/settings-store.js'
import { showConsolePanel } from './open-console.js'
import { moveToRight, openingMode } from './dock-side.js'

export interface DevToolsDeps {
  /** The app whose permissions a page's console would act with, or null for a page that is not one. Decided by the
   * session the page runs in, not by its address alone: a popup an app opened is at `about:blank` and has its opener.
   * `key` names the app for the once-only question; `label` is what the question shows. */
  appOf: (contents: WebContents) => { readonly key: string, readonly label: string } | null
  /** One of the shell's own pages (Settings, ...). */
  isShellPage: (contents: WebContents) => boolean
  /** The developer-only overrides are on (set from outside the browser, never from a page). */
  developerMode: () => boolean
  /** Asks whether to go ahead, for the app shown as `label`. Drawn in the tab of `contents`. */
  confirm: (contents: WebContents, label: string) => Promise<boolean>
}

/** What a tab's own menu needs of developer tools. */
export interface DevToolsGate {
  allowed: (contents: WebContents) => boolean
  inspect: (contents: WebContents, x: number, y: number) => Promise<void>
  /** Closes the tools on `contents`, which is about to stop being the page a tab shows. A view whose page is already gone passes undefined. */
  closeFor: (contents: WebContents | undefined) => void
}

export class DevToolsService implements DevToolsGate {
  /** Apps already asked about in this run. */
  private readonly confirmed = new Set<string>()
  /** Apps whose question is open now: a second request for one does not stack another question on it. */
  private readonly asking = new Set<string>()
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
  async toggle (contents: WebContents | undefined): Promise<void> {
    if (contents === undefined || contents.isDestroyed()) return
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools()
      return
    }
    if (await this.permitted(contents) && !contents.isDevToolsOpened()) this.show(contents)
  }

  /** Opens them on the Console panel, or moves an open set there. The same rules as `toggle`. */
  async openConsole (contents: WebContents | undefined): Promise<void> {
    if (contents === undefined || contents.isDestroyed() || !await this.permitted(contents)) return
    if (!contents.isDevToolsOpened()) this.show(contents)
    showConsolePanel(contents)
  }

  async inspect (contents: WebContents, x: number, y: number): Promise<void> {
    if (contents.isDestroyed() || !await this.permitted(contents)) return
    if (!contents.isDevToolsOpened()) this.show(contents)
    contents.inspectElement(x, y)
  }

  closeFor (contents: WebContents | undefined): void {
    if (contents === undefined) return
    this.open.delete(contents)
    if (!contents.isDestroyed() && contents.isDevToolsOpened()) contents.closeDevTools()
  }

  /** `permit`, and the page still there afterwards: the question can stay open while its tab is closed. */
  private async permitted (contents: WebContents): Promise<boolean> {
    return await this.permit(contents) && !contents.isDestroyed()
  }

  /** Whether to go on, asking once per app. The question stays open while the person reads it, so the page may have gone, or
   * moved to another app, by the time it is answered: the answer then counts for nothing. */
  private async permit (contents: WebContents): Promise<boolean> {
    if (!this.allowed(contents)) return false
    const app = this.deps.appOf(contents)
    if (app === null || this.confirmed.has(app.key)) return true
    if (this.asking.has(app.key)) return false
    this.asking.add(app.key)
    let yes = false
    try {
      yes = await this.deps.confirm(contents, app.label)
    } finally {
      this.asking.delete(app.key)
    }
    if (!yes || contents.isDestroyed() || this.deps.appOf(contents)?.key !== app.key) return false
    this.confirmed.add(app.key)
    return this.allowed(contents)
  }

  private show (contents: WebContents): void {
    const dock = this.settings.get('developer.dock')
    contents.openDevTools({ mode: openingMode(dock) })
    if (dock === 'right') moveToRight(contents)
    this.open.add(contents)
    // A tab torn down with its tools open may no longer be able to name this page.
    const forget = (): void => { this.open.delete(contents) }
    contents.once('destroyed', forget)
    // Each open adds a listener for the page's whole life, so closing the tools takes it away again.
    contents.once('devtools-closed', () => { forget(); contents.removeListener('destroyed', forget) })
  }
}
