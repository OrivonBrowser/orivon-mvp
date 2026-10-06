// How a tab comes into the collection: a new tab, a blob: tab, a trusted
// caller's target, one of the shell's own pages, or a popup Chromium already
// made. It builds through the factory and registers through the narrow host
// TabManager gives it, so it holds no tab state itself.
import type { LoadURLOptions, WebContents, WebContentsView } from 'electron'
import { internalUrl } from '../pages/internal-pages.js'
import type { InternalPageId } from '../pages/internal-pages.js'
import { knownFileProtocolFuse } from '../local-files/file-fuse.js'
import type { BuiltTab, TabFactory } from './tab-factory.js'
import type { TabRecord } from './tab-types.js'

export interface TabOpenerHost {
  add: (id: string, record: TabRecord) => void
  activate: (id: string) => void
  /** Pushes state to the chrome. */
  changed: () => void
  atCapacity: () => boolean
  activeId: () => string | null
  records: () => Iterable<readonly [string, TabRecord]>
  /** A tab opened on the start page, in front: where the keyboard goes is decided for it (./new-tab-focus.ts). Absent in tests. */
  freshTabInFront?: (id: string, contents: WebContents) => void
  /** Tells the person a local file was not opened because this copy of Orivon cannot open one safely. Absent in tests. */
  localFilesRefused?: () => void
}

export class TabOpener {
  constructor (
    private readonly host: TabOpenerHost,
    private readonly factory: TabFactory
  ) {}

  // `active` false leaves the view detached (nowhere live to land, pane-host.ts's fix is the other
  // half) behind the current tab, until a later `activateTab` -- popups.ts's `windowOpenHandler` on
  // a middle/ctrl-click. `loadOptions` -- `loadOptionsFor`'s doc: a form submit's referrer/POST body.
  private addAndShow (built: BuiltTab & { target: string }, active: boolean, loadOptions?: LoadURLOptions): string {
    this.host.add(built.id, built.record)
    if (active) this.host.activate(built.id)
    else this.host.changed()
    void built.record.view.webContents.loadURL(built.target, loadOptions)
    return built.id
  }

  /** `active`/`loadOptions` -- `addAndShow`'s own doc. Refuses rather than crashes at MAX_TABS
   * -- a caller that uses the id (a split's partner) checks atCapacity() first. */
  createTab (url?: string, active = true, loadOptions?: LoadURLOptions): string {
    if (this.host.atCapacity()) return this.host.activeId() ?? ''
    const built = this.factory.content(url)
    const id = this.addAndShow(built, active, loadOptions)
    if (url === undefined && active) this.host.freshTabInFront?.(id, built.record.view.webContents)
    return id
  }

  /** A same-origin blob: URL a no-guest popup open wants (popups.ts's own doc), directly in
   * `partition` -- the opener's own; skips `createTab`'s partitionForTarget/sanitizeDirectUrl,
   * neither of which fits a URL with no origin of its own that nobody could ever type. */
  openBlobTab (url: string, partition: string | undefined, active = true, loadOptions?: LoadURLOptions): string {
    if (this.host.atCapacity()) return this.host.activeId() ?? ''
    return this.addAndShow(this.factory.blob(url, partition), active, loadOptions)
  }

  /** A local file in a new tab of its local-files session, whole (query and fragment kept). Undefined for a URL `localFileKey` refuses, at MAX_TABS, and while the binary's
   * file-protocol fuse is not known to be off: with it on, a local page could read other files, so no tab opens and the person is told. */
  openLocalFile (url: string, active = true): string | undefined {
    if (this.host.atCapacity()) return undefined
    if (knownFileProtocolFuse() !== 'off') {
      this.host.localFilesRefused?.()
      return undefined
    }
    const built = this.factory.localFile(url)
    return built === undefined ? undefined : this.addAndShow(built, active)
  }

  /** createTab() for a trusted caller (the extension host): skips the sanitizeDirectUrl gate that refuses chrome-extension: outright, since its own policy already checked `target`. */
  openTrusted (target?: string): [string, WebContents] | undefined {
    if (this.host.atCapacity()) return undefined
    const built = target === undefined ? this.factory.content() : this.factory.trusted(target)
    this.host.add(built.id, built.record)
    void built.record.view.webContents.loadURL(built.target)
    this.host.activate(built.id)
    if (target === undefined) this.host.freshTabInFront?.(built.id, built.record.view.webContents)
    return [built.id, built.record.view.webContents]
  }

  /** Shows one of the shell's own pages: the tab that already has it, or a new
   * one. A page has one tab per window, so a second request finds the first
   * (and takes it to `path` if it is elsewhere). Only the shell calls this: a
   * website's `window.open` reaches `createTab`, which refuses an `orivon:`
   * URL. Its view stays on its page (./pages/internal-tab.ts). */
  openInternal (page: InternalPageId, path = '/'): void {
    const url = internalUrl(page, path)
    for (const [id, record] of this.host.records()) {
      if (record.internalPage !== page) continue
      this.host.activate(id)
      if (!record.view.webContents.isDestroyed() && record.view.webContents.getURL() !== url) void record.view.webContents.loadURL(url)
      return
    }
    if (this.host.atCapacity()) return

    const { id, record } = this.factory.internal(page)
    this.host.add(id, record)
    void record.view.webContents.loadURL(url)
    this.host.activate(id)
  }

  /** A popup Chromium already created (./popups.ts); it navigates itself. `active` -- `addAndShow`'s doc. */
  adoptPopup (view: WebContentsView, partition: string | undefined, active = true): void {
    const { id, record } = this.factory.popup(view, partition)
    this.host.add(id, record)
    if (active) this.host.activate(id)
    else this.host.changed()
  }
}
