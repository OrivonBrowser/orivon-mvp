// Builds the extension command keys from the real session, registry and shell,
// for extensions-subsystem.ts: which extensions are loaded and in what order,
// what a shortcut may reach, and how a page that recorded a key hears of it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { session } from 'electron'
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { INTERNAL_EVENT_CHANNEL } from '../channels.js'
import type { SubsystemContext } from '../registry.js'
import { anchorFor } from './extension-action-anchor.js'
import { createExtensionCommandKeys } from './extension-commands-runner.js'
import type { ExtensionCommandKeys, LoadedExtension } from './extension-commands-runner.js'
import { extensionHost } from './extension-host.js'
import type { ExtensionPrefsStore } from './extension-prefs.js'
import { recordTabCaptureInvocation } from './extension-tab-capture-invocation.js'
import { readRegistry } from './registry-runner.js'

export interface InstallCommandKeysOptions {
  readonly ctx: SubsystemContext
  readonly prefs: ExtensionPrefsStore
  readonly userDataPath: string
}

/** The loaded manifest hands its commands over sorted by name; the page lists them as the manifest's author did. */
function inFileOrder (folder: string, loaded: Record<string, unknown>): unknown {
  try {
    const written = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as { commands?: unknown }
    return typeof written.commands === 'object' && written.commands !== null ? { ...loaded, commands: written.commands } : loaded
  } catch {
    return loaded
  }
}

export function installExtensionCommands (options: InstallCommandKeysOptions): ExtensionCommandKeys {
  const { ctx, prefs, userDataPath } = options
  const extensions = session.defaultSession.extensions

  // What the session has loaded is the truth (an install loads before it is written to the registry); the registry
  // only says which was installed first. A private runtime loads nothing and reads no registry.
  // The files are read once per load: a prefs change rebuilds the table on the next keystroke, and that must not touch the disk.
  const read = new Map<string, { manifest: unknown, installedAt: number }>()
  extensions.on('extension-loaded', () => { read.clear() })
  extensions.on('extension-unloaded', () => { read.clear() })

  const loaded = (): LoadedExtension[] => {
    if (ctx.privateSession) return []
    const live = extensions.getAllExtensions()
    if (live.some((extension) => !read.has(extension.id))) {
      const installedAt = new Map(readRegistry(userDataPath).map((entry) => [entry.id, entry.installedAt]))
      for (const extension of live) {
        if (read.has(extension.id)) continue
        read.set(extension.id, {
          manifest: inFileOrder(extension.path, extension.manifest as Record<string, unknown>),
          installedAt: installedAt.get(extension.id) ?? Number.MAX_SAFE_INTEGER
        })
      }
    }
    return live
      .map((extension) => ({ id: extension.id, name: extension.name, ...(read.get(extension.id) as { manifest: unknown, installedAt: number }) }))
      .sort((a, b) => a.installedAt - b.installedAt)
      .map(({ id, name, manifest }) => ({ id, name, manifest }))
  }

  return createExtensionCommandKeys({
    platform: process.platform,
    prefs,
    extensions: loaded,
    onExtensionsChanged: (listener) => {
      extensions.on('extension-loaded', listener)
      extensions.on('extension-unloaded', listener)
      return () => {
        extensions.removeListener('extension-loaded', listener)
        extensions.removeListener('extension-unloaded', listener)
      }
    },
    host: extensionHost,
    keyChanged: (extensionId, change) => { extensionHost()?.getRouter().sendEvent(extensionId, 'commands.onChanged', change) },
    recordInvocation: recordTabCaptureInvocation,
    isHiddenTab: (tab) => {
      if (tab.session !== session.defaultSession) return true
      const origin = originFromUrl(tab.getURL())
      return origin !== null && ctx.broker?.app.hasGrantsSync(origin) === true
    },
    anchorFor,
    recorded: (page, outcome) => {
      const contents = page as WebContents
      if (!contents.isDestroyed()) contents.send(INTERNAL_EVENT_CHANNEL, { topic: 'extensions.shortcut-recorded', payload: outcome })
    },
    log: (message) => { console.error(`[extensions] ${message}`) }
  })
}
