// What the extensions page may ask of the installed extensions: list them
// with their resolved names, descriptions and icons, the details of one,
// enable or disable, remove, install from a file, and -- Developer mode
// only -- load unpacked or reload an unpacked install. Every request is data
// from a document, so every field is checked here; an id that names no
// registry entry is refused exactly like a malformed request (ADR-0041).
import type { InternalDomain } from '../pages/internal-ipc.js'
import { buildExtensionDetails, buildExtensionRow, findExtension } from './extensions-view.js'
import type { ExtensionFacts } from './extensions-view.js'
import type { ExtensionsApi } from './extensions-subsystem.js'
import type { InstallOutcome } from './install-runner.js'
import type { InstalledExtension } from './registry.js'

export interface ExtensionsDomainDeps {
  readonly extensions: ExtensionsApi
  readonly readFacts: (entry: InstalledExtension) => Promise<ExtensionFacts>
  readonly developerModeEnabled: () => boolean
  readonly pickFolder: () => Promise<string | undefined>
  readonly pickFile: () => Promise<string | undefined>
  /** Called once a command actually changed the registry: installed, removed, enabled or disabled. */
  readonly notify: () => void
}

interface ExtensionsRequest {
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
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as ExtensionsRequest
      switch (request.type) {
        case 'list': {
          const rows = await Promise.all(entries().map(async (entry) => buildExtensionRow(entry, await deps.readFacts(entry))))
          return { rows }
        }
        case 'details': {
          const entry = findExtension(entries(), request.id)
          if (entry === undefined) return undefined
          return { details: buildExtensionDetails(entry, await deps.readFacts(entry)) }
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
          const dir = await deps.pickFolder()
          return dir === undefined ? CANCELLED : await install(deps.extensions.installFromFolder(dir))
        }
        case 'reload': {
          if (!deps.developerModeEnabled()) return undefined
          const entry = findExtension(entries(), request.id)
          if (entry === undefined || entry.source.kind !== 'unpacked') return undefined
          return await install(deps.extensions.installFromFolder(entry.source.from))
        }
        case 'installFromFile': {
          const file = await deps.pickFile()
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
        default:
          return undefined
      }
    }
  }
}
