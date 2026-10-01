// Wires saving and filling passwords: the watcher's channel, what it does with each message, the
// navigations that decide whether a sign-in worked, and the settings and vault changes that tell every
// page's watcher what it may do now. Registered in `../shell/shell-installers.ts`.
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import type { ShellServices } from '../shell/shell-services.js'
import { formWatch, installFormWatchIpc } from './form-watch-ipc.js'
import { formsFor } from './forms-registry.js'
import { oncePerTurn } from './once-per-turn.js'
import { SUGGEST_KEYS } from './suggest-keys.js'

function wireMessages (services: ShellServices): void {
  formWatch.on('hello', (_message, sender) => { formsFor(sender.window, services).hello(sender) })
  formWatch.on('fields', (message, sender) => { formsFor(sender.window, services).fields(sender, message) })
  formWatch.on('focus', (message, sender) => { formsFor(sender.window, services).focus(sender, message) })
  formWatch.on('blur', (_message, sender) => { formsFor(sender.window, services).blur(sender) })
  formWatch.on('submit', (message, sender) => { formsFor(sender.window, services).submit(sender, message) })
}

function wireNavigations (services: ShellServices): void {
  const wired = new WeakSet<WebContents>()
  const report = (contents: WebContents, url: string, inPage: boolean, status: number): void => {
    const tab = services.windows.findTab(contents)
    if (tab === null) return
    formsFor(tab.window, services).navigated(tab.tabId, { inPage, status, origin: originFromUrl(url) })
  }
  const wire = (contents: WebContents): void => {
    if (wired.has(contents)) return
    wired.add(contents)
    contents.on('did-navigate', (_event, url, status) => { report(contents, url, false, status) })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) report(contents, url, true, -1) })
    // The chooser under a focused box never holds the keyboard, so it is offered the few keys it uses before the page sees them.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.control || input.meta || input.alt || input.shift || !SUGGEST_KEYS.has(input.key)) return
      const tab = services.windows.findTab(contents)
      if (tab !== null && formsFor(tab.window, services).keyFor(tab.tabId, input.key)) event.preventDefault()
    })
  }
  services.tabLifecycle.subscribe({
    tabCreated: (contents) => { wire(contents) },
    viewReplaced: (_old, contents) => { wire(contents) },
    tabClosing: ({ id, window }) => {
      const owner = services.windows.all().find((entry) => entry.window === window)
      if (owner !== undefined) formsFor(owner, services).tabGone(id)
    }
  })
}

export const installFormWatch: ShellInstaller = {
  name: 'form-watch',
  install: (_app, services) => {
    installFormWatchIpc(ipcMain, services.windows)
    wireMessages(services)
    wireNavigations(services)
    const configChanged = (): void => { for (const window of services.windows.all()) formsFor(window, services).configChanged() }
    services.settings.onChange(({ key }) => { if (key.startsWith('passwords.')) configChanged() })
    services.passwords.onChange(oncePerTurn(configChanged))
  }
}
