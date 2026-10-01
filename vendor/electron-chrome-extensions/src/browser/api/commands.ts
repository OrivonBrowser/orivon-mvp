import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { filterTabDetails } from './tabs'

export class CommandsAPI {
  private commandMap = new Map</* extensionId */ string, chrome.commands.Command[]>()

  // Orivon patch (UPSTREAM.md patch 60): how `send` reads a tab's details, supplied by
  // `TabsAPI` (built after this class), so the event carries the same shape `chrome.tabs.get` returns.
  constructor(
    private ctx: ExtensionContext,
    private tabDetails: (tab: Electron.WebContents) => Partial<chrome.tabs.Tab> | undefined = () =>
      undefined,
  ) {
    const handle = this.ctx.router.apiHandler()
    handle('commands.getAll', this.getAll)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-loaded', (_event, extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.removeCommands(extension)
    })
  }

  private processExtension(extension: Electron.Extension) {
    const manifest: chrome.runtime.Manifest = extension.manifest
    if (!manifest.commands) return

    if (!this.commandMap.has(extension.id)) {
      this.commandMap.set(extension.id, [])
    }
    const commands = this.commandMap.get(extension.id)!

    for (const [name, details] of Object.entries(manifest.commands!)) {
      // TODO: attempt to register commands
      commands.push({
        name,
        description: details.description,
        shortcut: '',
      })
    }
  }

  private removeCommands(extension: Electron.Extension) {
    this.commandMap.delete(extension.id)
  }

  /**
   * Orivon patch (UPSTREAM.md patch 60): fires `chrome.commands.onCommand(name, tab)` in one
   * extension, starting its service worker if it is stopped. Orivon's own trusted code calls it
   * when a shortcut the person bound to the command is pressed; no extension message reaches it.
   * The tab goes through the same URL/title filter as every other tab handed to an extension.
   */
  send(extensionId: string, name: string, tab: Electron.WebContents | undefined) {
    const manifest = (this.ctx.session.extensions || this.ctx.session).getExtension(extensionId)
      ?.manifest
    if (!manifest) return
    const details = tab ? this.tabDetails(tab) : undefined
    const visible = details
      ? filterTabDetails(
          { type: 'frame', sender: undefined, extension: { id: extensionId, manifest } } as any,
          details,
        )
      : undefined
    this.ctx.router.sendEvent(extensionId, 'commands.onCommand', name, ...(visible ? [visible] : []))
  }

  private getAll = ({ extension }: ExtensionEvent): chrome.commands.Command[] => {
    return this.commandMap.get(extension.id) || []
  }
}
