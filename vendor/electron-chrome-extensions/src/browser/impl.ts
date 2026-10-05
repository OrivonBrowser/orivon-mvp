/** App-specific implementation details for extensions. */
export interface ChromeExtensionImpl {
  createTab?(
    details: chrome.tabs.CreateProperties,
  ): Promise<[Electron.WebContents, Electron.BaseWindow]>
  selectTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void
  removeTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void

  /**
   * Populate additional details to a tab descriptor which gets passed back to
   * background pages and content scripts.
   */
  assignTabDetails?(details: chrome.tabs.Tab, tab: Electron.WebContents): void

  createWindow?(details: chrome.windows.CreateData): Promise<Electron.BaseWindow>
  removeWindow?(window: Electron.BaseWindow): void

  /**
   * Orivon patch: when provided, used by tabs.ts's `update()` instead of
   * calling `tab.loadURL(url)` directly, so a `chrome.tabs.update({ url })`
   * navigation passes through the same URL policy a created tab does.
   */
  navigateTab?(tab: Electron.WebContents, url: string): void | Promise<void>

  /**
   * Orivon patch (UPSTREAM.md patch 65): the window a toolbar's own page (a
   * `<browser-action-list>` host) belongs to, so each window's toolbar shows and acts on that
   * window's active tab.
   */
  windowOf?(contents: Electron.WebContents): Electron.BaseWindow | undefined

  /**
   * Orivon patch (UPSTREAM.md patch 70): the pages of the extension that are not tabs and not its popup, such
   * as a side panel's page, with the window each one belongs to. `chrome.runtime.getContexts` lists them.
   */
  extensionContexts?(
    extensionId: string,
  ): Array<{ contextType: 'SIDE_PANEL'; contents: Electron.WebContents; windowId: number }>

  /**
   * Orivon patch (UPSTREAM.md patch 70): a click on one of the extension's context-menu items, called before the
   * extension's `contextMenus.onClicked` is sent. The click is input the person made on the extension.
   */
  menuItemClicked?(extensionId: string, tab: Electron.WebContents): void

  /**
   * Orivon patch (UPSTREAM.md patch 67): when a tab already shows `url`, brings it to the front
   * and answers true. `chrome.runtime.openOptionsPage()` asks before it opens a tab.
   */
  activateTabShowing?(url: string): boolean

  requestPermissions?(
    extension: Electron.Extension,
    permissions: chrome.permissions.Permissions,
  ): Promise<boolean>
}
