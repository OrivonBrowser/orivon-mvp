// What the extensions page may ask of the installed extensions: list them
// with their resolved names, descriptions and icons, the details of one,
// enable or disable, remove, install from a file, and -- Developer mode
// only -- load unpacked or reload an unpacked install. Every request is data
// from a document, so every field is checked here; an id that names no
// registry entry is refused exactly like a malformed request (ADR-0041).
import type { WebContents } from 'electron'
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { ElectronChromeExtensions } from 'orivon:crx-extensions'
import type { ShellServices } from '../shell/shell-services.js'
import { buildExtensionDetails, buildExtensionRow, findExtension } from './extensions-view.js'
import type { ExtensionFacts } from './extensions-view.js'
import { DETAIL_PARTS, mergeParts, ROW_PARTS } from './extensions-detail-parts.js'
import { EXTENSION_PAGE_COMMANDS } from './extensions-page-commands.js'
import type { ExtensionPrefsStore } from './extension-prefs.js'
import type { ExtensionsApi } from './extensions-subsystem.js'
import type { InstallOutcome } from './install-runner.js'
import type { InstalledExtension } from './registry.js'

export interface ExtensionsDomainDeps {
  readonly extensions: ExtensionsApi
  readonly prefs: ExtensionPrefsStore
  /** The extension library's host; undefined until the subsystem has built it. */
  readonly host: () => ElectronChromeExtensions | undefined
  readonly shell: ShellServices
  /** A private or guest runtime: the page offers no install and says why. */
  readonly isPrivate: boolean
  readonly readFacts: (entry: InstalledExtension) => Promise<ExtensionFacts>
  readonly developerModeEnabled: () => boolean
  /** The pickers get the extensions page that asked, so each opens over its own window. */
  readonly pickFolder: (page: WebContents) => Promise<string | undefined>
  readonly pickFile: (page: WebContents) => Promise<string | undefined>
  /** Called once a command actually changed the registry: installed, removed, enabled or disabled. */
  readonly notify: () => void
}

interface ExtensionsRequest {
  readonly [field: string]: unknown
  readonly type?: unknown
  readonly id?: unknown
  readonly enabled?: unknown
}

const CANCELLED: InstallOutcome = { installed: false, reason: 'cancelled' }

export function extensionsDomain (deps: ExtensionsDomainDeps): InternalDomain {
  const entries = (): readonly InstalledExtension[] => deps.extensions.list()

  async function install (outcome: Promise<InstallOutcome>): Promise<InstallOutcome> {
    const result = await outcome
    if (result.installed) deps.notify()
    return result
  }

  return {
    pages: ['extensions'],
    handle: async (command, caller) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as ExtensionsRequest
      switch (request.type) {
        case 'context':
          return { isPrivate: deps.isPrivate }
        case 'list': {
          const rows = await Promise.all(entries().map(async (entry) => {
            const facts = await deps.readFacts(entry)
            const row = buildExtensionRow(entry, facts)
            return { ...row, parts: mergeParts(ROW_PARTS, entry, facts, deps) }
          }))
          return { rows }
        }
        case 'details': {
          const entry = findExtension(entries(), request.id)
          if (entry === undefined) return undefined
          const facts = await deps.readFacts(entry)
          const details = buildExtensionDetails(entry, facts)
          return { details: { ...details, row: { ...details.row, parts: mergeParts(ROW_PARTS, entry, facts, deps) }, parts: mergeParts(DETAIL_PARTS, entry, facts, deps) } }
        }
        case 'setEnabled': {
          const entry = findExtension(entries(), request.id)
          if (entry === undefined || typeof request.enabled !== 'boolean') return undefined
          await deps.extensions.setEnabled(entry.id, request.enabled)
          deps.notify()
          return { ok: true }
        }
        case 'remove': {
          const entry = findExtension(entries(), request.id)
          if (entry === undefined) return undefined
          await deps.extensions.uninstall(entry.id)
          deps.notify()
          return { ok: true }
        }
        case 'loadUnpacked': {
          if (!deps.developerModeEnabled()) return undefined
          const dir = await deps.pickFolder(caller.contents)
          return dir === undefined ? CANCELLED : await install(deps.extensions.installFromFolder(dir))
        }
        case 'reload': {
          if (!deps.developerModeEnabled()) return undefined
          const entry = findExtension(entries(), request.id)
          if (entry === undefined || entry.source.kind !== 'unpacked') return undefined
          return await install(deps.extensions.installFromFolder(entry.source.from))
        }
        case 'installFromFile': {
          const file = await deps.pickFile(caller.contents)
          return file === undefined ? CANCELLED : await install(deps.extensions.installFromFile(file))
        }
        case 'checkForUpdates': {
          await deps.extensions.checkForUpdates()
          deps.notify()
          return { ok: true }
        }
        case 'updateNow': {
          const entry = findExtension(entries(), request.id)
          if (entry === undefined) return undefined
          return await install(deps.extensions.updateFromStore(entry.id))
        }
        default: {
          const command = typeof request.type === 'string' && Object.hasOwn(EXTENSION_PAGE_COMMANDS, request.type)
            ? EXTENSION_PAGE_COMMANDS[request.type]
            : undefined
          return command === undefined ? undefined : await command(request, deps, caller)
        }
      }
    }
  }
}
